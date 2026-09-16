import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ settings = {}, deferredReply = false, deferredEntry = false, deferredExit = false, exitFails = false } = {}) {
  const events = new Map();
  const replies = [];
  let message, change, activation = false, finishEntry, finishExit;
  const counts = { requests: 0, exits: 0, mediaHandlers: 0 };
  const video = {
    paused: false, ended: false, readyState: 4, currentTime: 10,
    videoWidth: 1280, duration: 600, muted: false, volume: 1,
    getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }),
    requestPictureInPicture() {
      counts.requests++;
      if (!activation) return Promise.reject(Object.assign(new Error('activation required'), { name: 'NotAllowedError' }));
      activation = false;
      if (deferredEntry) return new Promise(resolve => { finishEntry = () => { document.pictureInPictureElement = video; resolve(); }; });
      document.pictureInPictureElement = video;
      return Promise.resolve();
    }
  };
  const document = {
    visibilityState: 'visible', pictureInPictureEnabled: true, pictureInPictureElement: null,
    querySelectorAll: selector => selector === 'video' ? [video] : [],
    addEventListener: (type, listener) => events.set(type, listener),
    async exitPictureInPicture() {
      counts.exits++;
      if (exitFails) throw Object.assign(new Error('exit rejected'), { name: 'InvalidStateError' });
      if (deferredExit) await new Promise(resolve => { finishExit = resolve; });
      document.pictureInPictureElement = null;
      events.get('leavepictureinpicture')?.();
    }
  };
  const window = { innerWidth: 1500, innerHeight: 900 };
  window.top = window;
  const chrome = {
    storage: {
      sync: { get: (defaults, callback) => callback({ ...defaults, ...settings }) },
      onChanged: { addListener: listener => { change = listener; } }
    },
    runtime: {
      onMessage: { addListener: listener => { message = listener; } },
      sendMessage: (_, callback) => deferredReply ? replies.push(callback) : callback({ tabSwitch: true })
    }
  };
  vm.runInNewContext(source, {
    window, document, chrome,
    navigator: { mediaSession: { setActionHandler: () => { counts.mediaHandlers++; } } }
  });
  return {
    counts, document, video, replies,
    gesture() { activation = true; },
    finishEntry() { finishEntry(); },
    finishExit() { finishExit(); },
    browserClose() { document.pictureInPictureElement = null; events.get('leavepictureinpicture')?.(); },
    toggle() { return new Promise(resolve => message({ type: 'pip:toggle' }, {}, resolve)); },
    async visibility(state) { document.visibilityState = state; void events.get('visibilitychange')(); await flush(); },
    change(values) { change(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'sync'); },
    status() { let state; message({ type: 'pip:status' }, {}, value => { state = value; }); return state; }
  };
}

async function enterByTabSwitch(env) {
  env.gesture();
  await env.visibility('hidden');
}

test('does not register, replace or clear the site media session handler', () => {
  const env = setup();
  assert.equal(env.counts.mediaHandlers, 0);
});

test('tab departure enters with activation and return closes', async () => {
  const env = setup();
  await enterByTabSwitch(env);
  assert.equal(env.document.pictureInPictureElement, env.video);
  await env.visibility('visible');
  assert.equal(env.document.pictureInPictureElement, null);
});

test('second entry without fresh activation remains an explicit known limitation', async () => {
  const env = setup();
  await enterByTabSwitch(env);
  await env.visibility('visible');
  await env.visibility('hidden');
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.status().needsGesture, true);
});

test('popup exits even when the video is paused and automation is disabled', async () => {
  const env = setup();
  await enterByTabSwitch(env);
  env.video.paused = true;
  env.change({ enabled: false });
  assert.equal((await env.toggle()).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('browser close invalidates pending automatic requests in this hidden period', async () => {
  const env = setup({ deferredReply: true });
  env.gesture();
  await env.visibility('hidden');
  env.browserClose();
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.counts.requests, 0);
});

test('stale tab replies never reopen after returning', async () => {
  const env = setup({ deferredReply: true });
  env.gesture();
  await env.visibility('hidden');
  await env.visibility('visible');
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.counts.requests, 0);
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.document.pictureInPictureElement, env.video);
});

test('popup cancels entry before the window appears', async () => {
  const env = setup({ deferredEntry: true });
  await enterByTabSwitch(env);
  const result = env.toggle();
  env.finishEntry();
  assert.equal((await result).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('returning while entry is pending closes the resulting window', async () => {
  const env = setup({ deferredEntry: true });
  await enterByTabSwitch(env);
  await env.visibility('visible');
  env.finishEntry();
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
});

test('duplicate exit commands do not reopen or issue concurrent exits', async () => {
  const env = setup({ deferredExit: true });
  await enterByTabSwitch(env);
  const first = env.toggle();
  const second = env.toggle();
  assert.equal(env.counts.exits, 1);
  env.finishExit();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('failed browser exit is reported without claiming success', async () => {
  const env = setup({ exitFails: true });
  await enterByTabSwitch(env);
  const result = await env.toggle();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exit-failed');
  assert.equal(result.error, 'InvalidStateError');
});

test('switching apps does not enter PiP', async () => {
  const env = setup({ deferredReply: true });
  env.gesture();
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: false });
  await flush();
  assert.equal(env.counts.requests, 0);
});

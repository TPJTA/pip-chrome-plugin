import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup({ supported = true, settings = {}, deferredReply = false, deferredEntry = false, deferredExit = false, exitFails = false } = {}) {
  const events = new Map();
  const replies = [];
  let action, message, change, activation = false, finishEntry, finishExit;
  const counts = { requests: 0, exits: 0 };
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
    navigator: { mediaSession: { setActionHandler: (_, callback) => {
      if (!supported) throw new TypeError('unsupported action');
      action = callback;
    } } }
  });
  return {
    counts, document, video, replies,
    gesture() { activation = true; },
    finishEntry() { finishEntry(); },
    finishExit() { finishExit(); },
    browserClose() { document.pictureInPictureElement = null; events.get('leavepictureinpicture')?.(); },
    toggle() { return new Promise(resolve => message({ type: 'pip:toggle' }, {}, resolve)); },
    async visibility(state) { document.visibilityState = state; void events.get('visibilitychange')(); await flush(); },
    native(reason = 'contentoccluded') {
      // Browser-provided activation exists during the callback. A background round trip
      // before requestPictureInPicture would lose it in this regression harness.
      activation = true;
      action({ reason });
      activation = false;
    },
    change(values) { change(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'sync'); },
    status() { let state; message({ type: 'pip:status' }, {}, value => { state = value; }); return state; }
  };
}

test('native callback supports repeated away/return cycles without another page click', async () => {
  const env = setup();
  for (let i = 0; i < 3; i++) {
    await env.visibility('hidden');
    assert.equal(env.counts.requests, i, 'visibility handler must not race the native callback');
    env.native();
    await flush();
    assert.equal(env.document.pictureInPictureElement, env.video);
    await env.visibility('visible');
    assert.equal(env.document.pictureInPictureElement, null);
  }
  assert.deepEqual(env.counts, { requests: 3, exits: 3 });
});

test('disabled extension and paused videos do not enter native PiP', async () => {
  const env = setup();
  await env.visibility('hidden');
  env.change({ enabled: false });
  env.native();
  assert.equal(env.counts.requests, 0);
  env.change({ enabled: true });
  env.video.paused = true;
  env.native();
  assert.equal(env.counts.requests, 0);
});

test('late native callback after returning does not open PiP', async () => {
  const env = setup();
  await env.visibility('hidden');
  await env.visibility('visible');
  env.native();
  assert.equal(env.counts.requests, 0);
});

test('returning while entry is pending closes the resulting window', async () => {
  const env = setup({ deferredEntry: true });
  await env.visibility('hidden');
  env.native();
  env.native();
  assert.equal(env.counts.requests, 1, 'coalesce in-flight requests');
  await env.visibility('visible');
  env.finishEntry();
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.counts.exits, 1);
});

test('native window is cleaned up when background does not confirm a tab switch', async () => {
  const env = setup({ deferredReply: true });
  await env.visibility('hidden');
  env.native();
  await flush();
  env.replies.shift()({ tabSwitch: false });
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
});

test('legacy path ignores stale replies from an earlier hide event', async () => {
  const env = setup({ supported: false, deferredReply: true });
  env.gesture();
  await env.visibility('hidden');
  await env.visibility('visible');
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.counts.requests, 0);
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.counts.requests, 1);
});

test('legacy path reports consumed activation instead of attempting fake priming', async () => {
  const env = setup({ supported: false });
  env.gesture();
  await env.visibility('hidden');
  await env.visibility('visible');
  await env.visibility('hidden');
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.status().needsGesture, true);
  assert.equal(env.status().nativeAutoPip, false);
});

test('keep-floating setting uses legacy path and does not close on return', async () => {
  const env = setup({ settings: { exitOnReturn: false } });
  env.gesture();
  await env.visibility('hidden');
  env.native();
  await flush();
  assert.equal(env.counts.requests, 1);
  await env.visibility('visible');
  assert.equal(env.document.pictureInPictureElement, env.video);
});


test('manual media control toggles an existing window off instead of trying to enter again', async () => {
  const env = setup();
  env.native('other');
  await flush();
  assert.equal(env.document.pictureInPictureElement, env.video);
  env.native('other');
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
  assert.deepEqual(env.counts, { requests: 1, exits: 1 });
});

test('popup exit blocks native reopen until the next genuine tab departure', async () => {
  const env = setup();
  await env.visibility('hidden');
  env.native();
  await flush();
  const result = await env.toggle();
  assert.equal(result.ok, true);
  env.native();
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.counts.requests, 1);
  // A duplicate hidden event must not rearm automatic entry.
  await env.visibility('hidden');
  env.native();
  assert.equal(env.counts.requests, 1);
  await env.visibility('visible');
  await env.visibility('hidden');
  env.native();
  await flush();
  assert.equal(env.document.pictureInPictureElement, env.video);
});

test('browser close button or video menu prevents automatic reopening', async () => {
  const env = setup();
  await env.visibility('hidden');
  env.native();
  await flush();
  env.browserClose();
  env.native();
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.counts.requests, 1);
});

test('popup can cancel an in-flight entry before the window exists', async () => {
  const env = setup({ deferredEntry: true });
  await env.visibility('hidden');
  env.native();
  const response = env.toggle();
  env.finishEntry();
  const result = await response;
  assert.equal(result.ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
  env.native();
  assert.equal(env.counts.requests, 1);
});

test('entry is blocked while exit is pending and duplicate exits are coalesced', async () => {
  const env = setup({ deferredExit: true });
  await env.visibility('hidden');
  env.native();
  await flush();
  const first = env.toggle();
  const second = env.toggle();
  env.native();
  assert.equal(env.counts.requests, 1);
  assert.equal(env.counts.exits, 1);
  env.finishExit();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('popup reports actual exit failure instead of false success', async () => {
  const env = setup({ exitFails: true });
  await env.visibility('hidden');
  env.native();
  await flush();
  const result = await env.toggle();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exit-failed');
  assert.equal(result.error, 'InvalidStateError');
  assert.equal(result.state, 'pip');
});

test('unknown native action reason does not open a window', async () => {
  const env = setup();
  env.native('unknown');
  await flush();
  assert.equal(env.counts.requests, 0);
});


test('disabling automatic PiP does not prevent the browser manual control from exiting', async () => {
  const env = setup();
  env.native('other');
  await flush();
  env.change({ enabled: false });
  env.native('other');
  await flush();
  assert.equal(env.document.pictureInPictureElement, null);
});

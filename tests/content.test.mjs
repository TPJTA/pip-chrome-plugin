import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

/**
 * 轮询到条件成立为止。
 *
 * 可见态退出被推迟到「focus + 两帧 rAF + 300ms」之后，用例不去猜实现内部用了哪些
 * 计时器，只等**外部可观察状态**（窗口有没有关掉、退出调用了几次）稳定下来。
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待条件成立超时');
}

function setup({ settings = {}, deferredReply = false, deferredEntry = false, deferredExit = false, exitFails = false } = {}, t = null) {
  // 同一个事件类型可以有多个监听器（content.js 对 leavepictureinpicture 之外的类型
  // 也可能重复注册），因此这里保留全部，而不是只留最后一个。
  const events = new Map();
  const replies = [];
  // 页面侧排出来的定时器与动画帧都登记下来，用例结束时统一清掉：留下的 timer 会把
  // 测试进程拖住，TAP 报告器也就永远等不到收尾。
  const timers = new Set();
  const trackTimer = id => { timers.add(id); return id; };
  const clearTimers = () => {
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    timers.clear();
  };
  const emit = (type, event) => {
    for (const listener of [...(events.get(type) ?? [])]) listener(event);
  };

  /**
   * 一次 exitPictureInPicture() 调用。
   *
   * 悬着与否是**每一次调用自己**的状态，不是全局开关：真实生命周期里新的一次调用
   * 不会因为上一次还悬着就消失。用例通过 hang() 指定悬着的时长，用例结束时统一
   * 结算，避免未结算的 Promise 泄漏到下一个用例。
   */
  const exitCalls = [];
  let message, change, activation = false, finishEntry;
  // 后台复核的放行方式可以在用例中途切换：隐藏分支那一次可以先压住（等答复），
  // 好让浏览器原生派发成为本轮唯一的进入来源，之后再放行原生分支自己的那次核对。
  let replyDeferred = deferredReply;
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
    // 可见态那次延迟退出会先等页面重新拿到焦点。
    hasFocus: () => true,
    addEventListener: (type, listener) => {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(listener);
    },
    // content.js 会在 document 上派发桥接事件（MAIN world 的脚本转过来的）。
    dispatchEvent(event) {
      for (const listener of [...(events.get(event.type) ?? [])]) listener(event);
      return !event.defaultPrevented;
    },
    exitPictureInPicture() {
      counts.exits++;
      const call = { settle: null };
      exitCalls.push(call);
      if (exitFails) {
        return Promise.reject(Object.assign(new Error('exit rejected'), { name: 'InvalidStateError' }));
      }
      return new Promise(resolve => {
        const settle = () => {
          document.pictureInPictureElement = null;
          // 浏览器关掉窗口之后照常派发 leave：实现靠它复位来源与退出状态。
          emit('leavepictureinpicture', { type: 'leavepictureinpicture' });
          resolve();
        };
        call.settle = settle;
        // deferredExit 只给「退出调用一直悬着」的用例用：由 finishExit() 结算。
        if (!deferredExit) settle();
      });
    }
  };
  // content.js 的可见态退出要等「focus + 两帧 rAF + 300ms」，这里把用到的定时器与
  // 动画帧补上：全部是**有界**的真实计时器，并登记以便用例结束时清理。
  const window = {
    innerWidth: 1500, innerHeight: 900,
    // waitForFocus 会自己 removeEventListener，因此这里必须真的支持摘除。
    addEventListener: (type, listener) => {
      if (!events.has(`window:${type}`)) events.set(`window:${type}`, []);
      events.get(`window:${type}`).push(listener);
    },
    removeEventListener: (type, listener) => {
      const list = events.get(`window:${type}`);
      if (!list) return;
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    },
    // 实现调用的是 window.setTimeout / window.requestAnimationFrame，typeof 检查也
    // 针对这些成员，因此它们既要真实计时，也要登记。
    setTimeout: (callback, delay) => trackTimer(setTimeout(callback, delay)),
    setInterval: (callback, delay) => trackTimer(setInterval(callback, delay)),
    clearTimeout: id => { timers.delete(id); clearTimeout(id); },
    clearInterval: id => { timers.delete(id); clearInterval(id); },
    // 沙箱里没有原生 rAF，用 setTimeout(..., 16) 顶替。
    requestAnimationFrame: callback => trackTimer(setTimeout(() => callback(Date.now()), 16))
  };
  window.top = window;
  const chrome = {
    storage: {
      sync: { get: (defaults, callback) => callback({ ...defaults, ...settings }) },
      onChanged: { addListener: listener => { change = listener; } }
    },
    runtime: {
      onMessage: { addListener: listener => { message = listener; } },
      sendMessage: (_, callback) => replyDeferred ? replies.push(callback) : callback({ tabSwitch: true })
    }
  };
  // 站点自己注册了 enterpictureinpicture handler：桥接脚本把派发权交给站点，
  // 这里只要把这件事通过桥接事件告诉 content.js（等价于 MAIN world 的广播）。
  const markSiteHandler = () => {
    const event = {
      type: 'auto-pip:native-state', defaultPrevented: false,
      detail: { site: true, dispatcher: false, allowed: true },
      preventDefault() { this.defaultPrevented = true; }
    };
    document.dispatchEvent(event);
  };
  vm.runInNewContext(source, {
    window, document, chrome,
    navigator: { mediaSession: { setActionHandler: () => { counts.mediaHandlers++; } } },
    CustomEvent,
    // content.js 里 setTimeout 是裸全局引用，所以这两个也要按页面侧的方式登记。
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    clearTimeout,
    clearInterval,
    requestAnimationFrame: window.requestAnimationFrame
  });

  /** 立刻结算所有还悬着的退出调用（真实浏览器里 leave 后 PiP 就没了）。 */
  const settleExits = () => {
    const outstanding = exitCalls.splice(0, exitCalls.length);
    for (const call of outstanding) if (call.settle) call.settle();
  };
  // 统一收尾：结算悬着的退出调用、清掉登记过的页面侧定时器、摘掉监听器。
  // 少了这一步，挂起的 Promise 与 timer 会被带到下一个用例，断言受污染，进程也退不出去。
  if (t) t.after(() => { settleExits(); clearTimers(); events.clear(); });

  return {
    counts, document, video, replies, exitCalls,
    gesture() { activation = true; },
    finishEntry() { finishEntry(); },
    finishExit() { settleExits(); },
    /** 让当前这次退出调用一直悬着，直到用例显式 finishExit() 或结束时统一结算。 */
    hangCurrentExit() {
      const call = exitCalls.at(-1);
      if (call) call.settle = ((settle) => () => settle())(call.settle ?? (() => {}));
      if (call) call.hang = true;
      return call;
    },
    /** 切换后台复核答复的放行方式：true = 先压住，之后由用例自己 replies.shift() 放行。 */
    setReplyDeferred(value) { replyDeferred = Boolean(value); },
    /** 声明「站点自己持有 enterpictureinpicture handler」。 */
    remoteControlSiteHandler() { markSiteHandler(); },
    browserClose() {
      document.pictureInPictureElement = null;
      emit('leavepictureinpicture', { type: 'leavepictureinpicture' });
    },
    toggle() { return new Promise(resolve => message({ type: 'pip:toggle' }, {}, resolve)); },
    /** 派发桥接脚本转来的 DOM 事件，等价于 MAIN world 里 sendEvent() 的效果。 */
    bridge(type, detail) {
      const event = { type, detail, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      document.dispatchEvent(event);
      return event;
    },
    /** 派发桥接事件并等它内部的 await 链跑完。 */
    async deliver(type, detail) {
      this.bridge(type, detail);
      await flush();
      await flush();
    },
    async visibility(state) {
      document.visibilityState = state;
      emit('visibilitychange', { type: 'visibilitychange' });
      await flush();
    },
    change(values) { change(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'sync'); },
    status() { let state; message({ type: 'pip:status' }, {}, value => { state = value; }); return state; }
  };
}


async function enterByTabSwitch(env) {
  env.gesture();
  await env.visibility('hidden');
}

test('does not register, replace or clear the site media session handler', (t) => {
  const env = setup({}, t);
  assert.equal(env.counts.mediaHandlers, 0);
});

test('tab departure enters with activation and return closes', async (t) => {
  const env = setup({}, t);
  await enterByTabSwitch(env);
  assert.equal(env.document.pictureInPictureElement, env.video);

  await env.visibility('visible');
  // 可见分支不当场退出：稳定窗口结束前一次调用都不得发出。
  assert.equal(env.counts.exits, 0, '稳定窗口结束前不得退出');
  await waitFor(() => env.document.pictureInPictureElement === null);
  // 扩展自己 fallback 开的窗口：稳定窗口结束后由扩展显式退出，恰好一次。
  assert.equal(env.counts.exits, 1);
});

test('second entry without fresh activation remains an explicit known limitation', async (t) => {
  const env = setup({}, t);
  await enterByTabSwitch(env);
  await env.visibility('visible');
  // 先把上一轮收尾干净：窗口还开着的话，下面的断言测的就不是「第二次进入」。
  await waitFor(() => env.document.pictureInPictureElement === null);

  await env.visibility('hidden');
  assert.equal(env.document.pictureInPictureElement, null);
  assert.equal(env.status().needsGesture, true, '用户激活已被上一轮消耗，第二次不得重新进入');
});

test('popup exits even when the video is paused and automation is disabled', async (t) => {
  const env = setup({}, t);
  await enterByTabSwitch(env);
  env.video.paused = true;
  env.change({ enabled: false });
  assert.equal((await env.toggle()).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('browser close invalidates pending automatic requests in this hidden period', async (t) => {
  const env = setup({ deferredReply: true }, t);
  env.gesture();
  await env.visibility('hidden');

  // 浏览器在本轮复核答复回来之前就把浮窗关掉了（用户按了关闭按钮、或站点自己退出）。
  env.browserClose();
  // 答复此时才回来，且内容是「确实切了标签页」：它描述的是**已经作废的那一轮**。
  env.replies.shift()({ tabSwitch: true });
  await flush();

  // 用户刚在后台关掉了窗口：这一轮随之作废，那份旧答复不得把窗口重新开出来。
  assert.equal(env.counts.requests, 0, '关窗作废的那一轮不得再发出进入请求');
  assert.equal(env.document.pictureInPictureElement, null, '后台手动关窗后不得凭空出现浮窗');
  // 作废的是**这一轮**，不是本页的自动进入能力：下一次 hidden 周期仍须能重新进入。
  await env.visibility('visible');
  env.gesture();
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: true });
  await flush();
  assert.equal(env.document.pictureInPictureElement, env.video, '新的一轮必须能正常重新进入');
});

test('stale tab replies never reopen after returning', async (t) => {
  const env = setup({ deferredReply: true }, t);
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

test('popup cancels entry before the window appears', async (t) => {
  const env = setup({ deferredEntry: true }, t);
  await enterByTabSwitch(env);
  const result = env.toggle();
  env.finishEntry();
  assert.equal((await result).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('returning while entry is pending closes the resulting window', async (t) => {
  const env = setup({ deferredEntry: true }, t);
  await enterByTabSwitch(env);
  await env.visibility('visible');
  env.finishEntry();
  await flush();
  await waitFor(() => env.document.pictureInPictureElement === null);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('duplicate exit commands do not reopen or issue concurrent exits', async (t) => {
  const env = setup({ deferredExit: true }, t);
  await enterByTabSwitch(env);
  const first = env.toggle();
  const second = env.toggle();
  assert.equal(env.counts.exits, 1);
  env.finishExit();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(env.document.pictureInPictureElement, null);
});

test('failed browser exit is reported without claiming success', async (t) => {
  const env = setup({ exitFails: true }, t);
  await enterByTabSwitch(env);
  const result = await env.toggle();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exit-failed');
  assert.equal(result.error, 'InvalidStateError');
});

test('switching apps does not enter PiP', async (t) => {
  const env = setup({ deferredReply: true }, t);
  env.gesture();
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: false });
  await flush();
  assert.equal(env.counts.requests, 0);
});

/* ------------------------- 返回可见态：谁开的窗口就由谁收尾（外部行为） -- */

// A：浏览器原生自动画中画那一轮，扩展一次都不得调用退出 API；浏览器自己 leave
//    之后来源复位，下一轮仍能正常进入。
test('a native auto-PiP round is left to the browser and the next round still enters', async (t) => {
  // 隐藏态的后台复核先压住：隐藏分支因此停在「等答复」上，本轮真正的进入来源就只剩
  // 浏览器原生派发这一条，不会被扩展 fallback 抢先。
  const env = setup({ deferredReply: true }, t);
  env.gesture();
  await env.visibility('hidden');

  // 原生回调到达。它内部会再向后台核对一次，那次放行（deferredReply 已关）。
  env.document.visibilityState = 'hidden';
  env.setReplyDeferred(false);
  await env.deliver('auto-pip:enter', {});
  assert.equal(env.document.pictureInPictureElement, env.video, '原生回调必须能开出窗口');
  assert.equal(env.status().lastEntryOrigin, 'native-auto');

  await env.visibility('visible');
  // 稳定窗口（300ms 量级）跑完后依然一次都不能调用退出 API：来源不是 extension。
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(env.counts.exits, 0, '原生来源的返回不得发起显式退出');
  assert.equal(env.document.pictureInPictureElement, env.video);

  // 浏览器随后自行关闭：这一轮结束、来源复位，下一轮还能再进入。
  env.browserClose();
  assert.equal(env.status().lastEntryOrigin, null);
  env.gesture();
  await env.visibility('hidden');
  env.replies.shift()({ tabSwitch: true });
  await waitFor(() => env.document.pictureInPictureElement === env.video);
  assert.equal(env.document.pictureInPictureElement, env.video, '原生关闭后必须重新允许自动进入');
});

// B：扩展 fallback 开的窗口，返回后要等满稳定窗口才**恰好一次**退出，并释放
//    delayedExitInFlight —— 之后还能再进一轮并正常退出。
test('extension fallback exits exactly once after the stable window and releases the in-flight flag', async (t) => {
  const env = setup({}, t);
  await enterByTabSwitch(env);
  assert.equal(env.status().lastEntryOrigin, 'extension');

  await env.visibility('visible');
  // 稳定窗口没跑完之前，任何时刻都不得调用退出 API。
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(env.counts.exits, 0, '稳定窗口结束前不得退出');

  await waitFor(() => env.counts.exits === 1);
  assert.equal(env.status().deferredExit.delayedExitInFlight, null, '退出结束后必须释放 delayedExitInFlight');
  assert.equal(env.document.pictureInPictureElement, null);

  // 占位已释放：再来一轮仍能正常退出（没释放时这一次退出会被吞掉）。
  await enterByTabSwitch(env);
  await env.visibility('visible');
  await waitFor(() => env.counts.exits === 2);
  assert.equal(env.counts.exits, 2, 'delayedExitInFlight 未释放时这一次退出会被吞掉');
});

/* ------------------------------ 站点所有权的隐藏态优先窗口（外部行为） -- */

// C：站点 handler 在优先窗口内自己开窗时，扩展全程不得 fallback 进入。
test('a site-owned entry inside the priority window keeps the extension out', async (t) => {
  const env = setup({}, t);
  env.remoteControlSiteHandler();
  // 站点自己先把窗开好：进入权在站点，扩展只需要等。
  env.document.pictureInPictureElement = env.video;
  env.gesture();
  await env.visibility('hidden');
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(env.counts.requests, 0, '优先窗口内已经开窗时扩展一次都不得请求进入');
  assert.equal(env.status().lastEntryOrigin, 'site-owned');
  assert.equal(env.document.pictureInPictureElement, env.video);
  // 站点注册的 handler 不被扩展覆盖或清除。
  assert.equal(env.counts.mediaHandlers, 0, '扩展不得注册或替换站点自己的 media session handler');
});

// D：优先窗口内站点没有开窗时，窗口结束后仍要允许扩展按既有路径兜底进入，
//    并且同样不得碰站点的 handler。
test('a site handler that misses the priority window still lets the extension fall back', async (t) => {
  const env = setup({}, t);
  env.remoteControlSiteHandler();
  env.gesture();
  await env.visibility('hidden');

  // 站点这次没有自己开窗：优先窗口结束前扩展一次都不得抢着进入。
  assert.equal(env.counts.requests, 0, '优先窗口结束前扩展不得请求进入');
  await waitFor(() => env.document.pictureInPictureElement === env.video, 2500);
  // 兜底进入的来源记在扩展自己名下，返回时由扩展显式退出。
  assert.equal(env.status().lastEntryOrigin, 'extension');
  assert.equal(env.counts.mediaHandlers, 0, '兜底路径同样不得覆盖站点 handler');

  await env.visibility('visible');
  await waitFor(() => env.document.pictureInPictureElement === null);
  assert.equal(env.counts.exits, 1);
});

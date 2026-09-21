import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../native-pip-bridge.js', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 把 native-pip-bridge.js 跑进一个假的 MAIN world。
 * 记录每一次对原生 setActionHandler 的调用，这样「我们有没有真的登记到浏览器」
 * 和「有没有误清网站刚注册的处理器」都能被直接观察到。
 */
function setup({ withNative = true, nativeHook = null } = {}) {
  const nativeCalls = [];
  const nativeHandlers = new Map();
  const events = [];
  const dispatched = new Map();

  const session = withNative ? { id: 'session' } : null;

  function nativeSetActionHandler(action, handler) {
    // 允许测试在「桥接脚本安装之前」就插手原生方法，这样故障注入才会真的生效：
    // 桥接脚本会把自己安装那一刻的原生方法捕获下来，安装之后再替换原型上的属性
    // 是没用的，它根本不会再读那个属性。
    // arguments.length 一并透传：原生方法靠它区分「少传参数」的 TypeError 与
    // 「传 null 撤回」，包装层必须保留这个区别。
    if (nativeHook) nativeHook.apply(this, arguments);
    if (this !== session) {
      nativeCalls.push({ action, handler, receiver: this, foreign: true });
      return undefined;
    }
    nativeCalls.push({ action, handler, receiver: this, foreign: false });
    if (typeof handler === 'function') nativeHandlers.set(action, handler);
    else nativeHandlers.delete(action);
    return undefined;
  }

  function MediaSession() {}
  MediaSession.prototype.setActionHandler = nativeSetActionHandler;

  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      if (!dispatched.has(type)) dispatched.set(type, []);
      dispatched.get(type).push(listener);
    },
    dispatchEvent(event) {
      events.push({ type: event.type, detail: event.detail });
      for (const listener of dispatched.get(event.type) ?? []) listener(event);
      return !event.defaultPrevented;
    }
  };

  function CustomEvent(type, init = {}) {
    const event = { type, detail: init.detail, defaultPrevented: false };
    event.preventDefault = () => { event.defaultPrevented = true; };
    return event;
  }

  // 桥接脚本跑在别的 realm 里，`detail` 对象跨 realm 之后原型不同，
  // deepStrictEqual 会因为「结构相同但引用不同」失败。这里统一摊平成普通对象。
  const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  const mediaSession = withNative ? session : null;
  const navigator = withNative ? { mediaSession } : {};

  vm.runInNewContext(source, {
    window: {},
    document,
    navigator,
    MediaSession,
    CustomEvent,
    Object,
    Boolean
  });

  return {
    events,
    nativeCalls,
    nativeHandlers,
    MediaSession,
    session,
    // 网站当前在浏览器侧登记的处理器（桥接脚本不能偷偷改它）
    browserHandler() { return nativeHandlers.get('enterpictureinpicture') ?? null; },
    // 模拟网站调用 setActionHandler
    site(action, handler) {
      MediaSession.prototype.setActionHandler.call(session, action, handler);
    },
    // 模拟网站用别的 receiver 调用（不是这个 realm 的 mediaSession）
    foreignCall(action, handler) {
      MediaSession.prototype.setActionHandler.call({ other: true }, action, handler);
    },
    config(detail) {
      document.dispatchEvent({ type: 'auto-pip:config', detail, defaultPrevented: false });
    },
    visibility(state) {
      document.visibilityState = state;
    },
    /** 模拟浏览器把某个动作派发给「浏览器侧当前登记的那个处理器」。 */
    async deliver(reason) {
      const handler = nativeHandlers.get('enterpictureinpicture');
      const result = handler ? await handler({ reason }) : undefined;
      return { fired: Boolean(handler), result };
    },
    state() { return plain(events.filter((entry) => entry.type === 'auto-pip:native-state').at(-1)?.detail); },
    eventTypes() { return events.map((entry) => entry.type); },
    plain,
    detailOf(type) {
      return events.filter((entry) => entry.type === type).map((entry) => plain(entry.detail));
    }
  };
}

const PIP_CALLS = (env) => env.nativeCalls.filter((call) => call.action === 'enterpictureinpicture');

/* ------------------------------------------------------------------ 注册 -- */

test('registers a dispatcher with the real browser method once settings allow it', () => {
  const env = setup();
  assert.equal(PIP_CALLS(env).length, 0, '设置到达前不该碰浏览器');

  env.config({ enabled: true, exitOnReturn: true });
  const calls = PIP_CALLS(env);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].foreign, false, '必须在这个 realm 的 mediaSession 上调用原生方法');
  assert.equal(typeof calls[0].handler, 'function');
  assert.equal(typeof env.browserHandler(), 'function');
});

test('repeated config broadcasts never register twice', () => {
  const env = setup();
  env.config({ enabled: true, exitOnReturn: true });
  env.config({ enabled: true, exitOnReturn: true });
  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(PIP_CALLS(env).length, 1);
});

test('withdraws our dispatcher when either setting turns it off', () => {
  for (const detail of [
    { enabled: false, exitOnReturn: true },
    { enabled: true, exitOnReturn: false },
    { enabled: false, exitOnReturn: false }
  ]) {
    const env = setup();
    env.config({ enabled: true, exitOnReturn: true });
    env.config(detail);
    const calls = PIP_CALLS(env);
    assert.equal(calls.length, 2, JSON.stringify(detail));
    assert.equal(calls[1].handler, null, '撤回时必须以 null 覆盖');
    assert.equal(env.browserHandler(), null);
  }
});

test('announces readiness and current state to the isolated world', () => {
  const env = setup();
  const ready = env.detailOf('auto-pip:bridge-ready');
  assert.equal(ready.length, 1);
  assert.deepEqual(env.state(), { site: false, dispatcher: false, allowed: false });
  env.config({ enabled: true, exitOnReturn: true });
  assert.deepEqual(env.state(), { site: false, dispatcher: true, allowed: true });
});

/* ------------------------------------------------------ 网站自己的处理器 -- */

test("never overwrites a site handler that is already registered", () => {
  const env = setup();
  const siteHandler = () => 'site';
  env.site('enterpictureinpicture', siteHandler);
  env.config({ enabled: true, exitOnReturn: true });

  assert.equal(env.browserHandler(), siteHandler, '浏览器侧必须是网站自己的处理器');
  assert.equal(PIP_CALLS(env).length, 1, '允许之后不该再触发任何原生调用');
    assert.deepEqual(env.state(), { site: true, dispatcher: false, allowed: true });
});

test('site handler registered after ours must survive the handover', () => {
  const env = setup();
  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(typeof env.browserHandler(), 'function', '先由我们顶上');

  const siteHandler = () => 'site';
  env.site('enterpictureinpicture', siteHandler);

  // 这是最容易被写错的一步：交接时如果去调 unregister，就会把网站刚注册的
  // 处理器一起清掉，浏览器侧再也不会回调任何东西。
  assert.equal(env.browserHandler(), siteHandler);
  const calls = PIP_CALLS(env);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].handler, siteHandler, '第二次调用必须就是网站的注册');
});

test('browser delivery goes straight to the site handler, we stay out of the way', async () => {
  const env = setup();
  const seen = [];
  env.site('enterpictureinpicture', (details) => { seen.push(details.reason); return 'site'; });
  env.config({ enabled: true, exitOnReturn: true });

  const result = await env.deliver('contentoccluded');
  assert.equal(result.fired, true);
  assert.equal(result.result, 'site');
  assert.deepEqual(seen, ['contentoccluded']);
  assert.equal(env.detailOf('auto-pip:enter').length, 0, '有网站处理器时不该再转发事件');
});

test('clearing the site handler lets our dispatcher take over again', async () => {
  const env = setup();
  env.config({ enabled: true, exitOnReturn: true });
  env.visibility('hidden');
  env.site('enterpictureinpicture', () => 'site');
  env.site('enterpictureinpicture', null);

  const calls = PIP_CALLS(env);
  // ① 我们的注册 ② 网站的注册 ③ 网站清空（原样转发）④ 我们重新顶上
  assert.equal(calls.length, 4, JSON.stringify(calls.map((call) => typeof call.handler)));
  assert.equal(calls[2].handler, null, '网站那次清空必须如实转发');
  assert.equal(typeof calls[3].handler, 'function', '清空后必须重新注册');
  assert.equal(typeof env.browserHandler(), 'function');

  const result = await env.deliver('contentoccluded');
  assert.equal(result.fired, true);
  assert.equal(env.detailOf('auto-pip:enter').length, 1);
});

test('clearing the site handler with automation off leaves nothing registered', () => {
  const env = setup();
  env.config({ enabled: false, exitOnReturn: true });
  env.site('enterpictureinpicture', () => 'site');
  env.site('enterpictureinpicture', null);
  assert.equal(env.browserHandler(), null);
});

test('a site handler registered while automation is off is never touched', () => {
  const env = setup();
  env.config({ enabled: false, exitOnReturn: true });
  const siteHandler = () => 'site';
  env.site('enterpictureinpicture', siteHandler);
  assert.equal(env.browserHandler(), siteHandler);
  assert.equal(PIP_CALLS(env).length, 1, '关闭状态下不该有任何我们自己的注册');
});

/* ------------------------------------------------------------ 动作派发 -- */

test('hidden delivery becomes an automatic-entry request without relying on reason', async () => {
  const env = setup();
  env.config({ enabled: true, exitOnReturn: true });
  env.visibility('hidden');
  await env.deliver('contentoccluded');
  assert.deepEqual(env.detailOf('auto-pip:enter'), [{}]);
  assert.equal(env.detailOf('auto-pip:manual-toggle').length, 0);
});

test('visible deliveries become manual toggles instead of automatic entries', async () => {
  const env = setup();
  env.config({ enabled: true, exitOnReturn: true });
  env.visibility('visible');
  await env.deliver('other');
  await env.deliver(undefined);
  assert.equal(env.detailOf('auto-pip:enter').length, 0);
  assert.deepEqual(env.detailOf('auto-pip:manual-toggle'), [{}, {}]);
});

/* -------------------------------------------------------- 其它动作/接收者 -- */

test('unrelated media session actions pass straight through', () => {
  const env = setup();
  const play = () => 'play';
  env.site('play', play);
  assert.equal(env.browserHandler(), null, 'play 不该被当成 enterpictureinpicture');
  const call = env.nativeCalls.at(-1);
  assert.equal(call.action, 'play');
  assert.equal(call.handler, play);
});

test('calls from a different receiver are forwarded and never tracked as the site handler', () => {
  const env = setup();
  const foreignHandler = () => 'foreign';
  env.foreignCall('enterpictureinpicture', foreignHandler);
  assert.equal(env.browserHandler(), null, '别的 receiver 不能算作本页媒体会话的处理器');

  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(typeof env.browserHandler(), 'function', '本页仍然要顶上我们自己的 dispatcher');
  assert.deepEqual(env.state(), { site: false, dispatcher: true, allowed: true });
});

/* ------------------------------------------------------------ 降级路径 -- */

test('stays completely inert when the browser has no media session', () => {
  const env = setup({ withNative: false });
  assert.equal(env.nativeCalls.length, 0);
  // 不抛异常、不注册任何东西；设置到达后也一样
  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(env.nativeCalls.length, 0);
});

test('a failure while registering is reported and retried on the next change', () => {
  const calls = [];
  let failed = false;
  // 故障注入必须发生在桥接脚本安装之前：它只捕获安装那一刻的原生方法，
  // 之后再替换原型属性它根本读不到。
  const env = setup({
    nativeHook(action, handler) {
      calls.push({ action, handler });
      if (action === 'enterpictureinpicture' && typeof handler === 'function' && !failed) {
        failed = true;
        throw Object.assign(new Error('not supported'), { name: 'NotSupportedError' });
      }
    }
  });

  // 第一次注册失败：异常必须原样抛给调用方，内部状态不能假装成功。
  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(env.browserHandler(), null);
  assert.deepEqual(env.state(), { site: false, dispatcher: false, allowed: true });

  // 下一次设置变更必须重试，并且这次真的登记上去。
  env.config({ enabled: true, exitOnReturn: true });
  assert.equal(calls.length, 2, '失败后必须允许重试');
  assert.equal(typeof env.browserHandler(), 'function');
  assert.deepEqual(env.state(), { site: false, dispatcher: true, allowed: true });
});

/* ------------------------------------------------------ 原生实现完整性 -- */

test('passes the argument count through untouched', () => {
  const seen = [];
  const env = setup({
    nativeHook() { seen.push(arguments.length); }
  });
  // 原生实现靠参数个数区分「少传参数」的 TypeError 与「传 null 撤回」，
  // 包装层补一个显式 undefined 就会把这个区别抹掉。
  env.MediaSession.prototype.setActionHandler.call(env.session, 'enterpictureinpicture');
  env.MediaSession.prototype.setActionHandler.call(env.session, 'enterpictureinpicture', null);
  env.MediaSession.prototype.setActionHandler.call(env.session, 'play', () => {});
  assert.deepEqual(seen, [1, 2, 2]);
});

test('a throwing native method leaves the tracked state untouched', () => {
  let armed = false;
  const env = setup({
    nativeHook(action, handler) {
      if (armed && action === 'enterpictureinpicture' && typeof handler === 'function') {
        throw Object.assign(new Error('nope'), { name: 'NotSupportedError' });
      }
    }
  });
  // 先让网站真的注册成功一次（此时浏览器侧就是它），再打开故障注入。
  env.site('enterpictureinpicture', () => 'first');
  env.config({ enabled: true, exitOnReturn: true });
  const state = env.state();
  const held = env.browserHandler();
  assert.equal(typeof held, 'function', '第一次注册本该成功');

  armed = true;
  const siteHandler = () => 'second';
  assert.throws(() => env.site('enterpictureinpicture', siteHandler), { name: 'NotSupportedError' });
  // 原生方法抛错之后，内部状态和浏览器侧已有的处理器都不能被动到。
  assert.deepEqual(env.state(), state);
  assert.equal(env.browserHandler(), held);
});

test('keeps the wrapper when defineProperty writes it and only the assignment fails', () => {
  const env = setup();
  const native = env.MediaSession.prototype.setActionHandler;
  let trapped = false;
  const object = new Proxy(Object, {
    get(target, property, receiver) {
      if (property !== 'defineProperty') return Reflect.get(target, property, receiver);
      return (holder, name, descriptor) => {
        Reflect.defineProperty(holder, name, descriptor);
        // 属性其实已经装好了，只是返回值复制失败 —— 真实浏览器里就长这样。
        if (holder === env.MediaSession.prototype && name === 'setActionHandler' && !trapped) {
          trapped = true;
          throw new TypeError('Failed to copy the return value');
        }
        return holder;
      };
    }
  });

  const source = readFileSync(new URL('../native-pip-bridge.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    window: {},
    document: { addEventListener() {}, dispatchEvent() { return true; } },
    navigator: { mediaSession: env.session },
    MediaSession: env.MediaSession,
    CustomEvent: function CustomEvent(type) { this.type = type; },
    Object: object,
    Boolean
  });

  assert.equal(trapped, true, '故障注入没有生效');
  // 包装必须留着：这里若退回直接赋值，会把已经生效的包装静默回滚成原生方法。
  assert.equal(env.MediaSession.prototype.setActionHandler.name, 'wrappedSetActionHandler');
  assert.equal(env.MediaSession.prototype.setActionHandler.call(env.session, 'play', native), undefined);
});

test('stays inert when the prototype cannot be patched at all', () => {
  const env = setup();
  const nativeName = env.MediaSession.prototype.setActionHandler.name;
  const source = readFileSync(new URL('../native-pip-bridge.js', import.meta.url), 'utf8');
  const object = new Proxy(Object, {
    get(target, property, receiver) {
      if (property !== 'defineProperty') return Reflect.get(target, property, receiver);
      return () => { throw new TypeError('Cannot redefine property'); };
    }
  });

  vm.runInNewContext(source, {
    window: {},
    document: {
      addEventListener() {},
      dispatchEvent() { throw new Error('装不上就不该广播任何状态'); }
    },
    navigator: { mediaSession: env.session },
    MediaSession: env.MediaSession,
    CustomEvent: function CustomEvent(type) { this.type = type; },
    Object: object,
    Boolean
  });

  // 装不上就什么也不做，页面不会因为我们的包装炸掉。
  assert.equal(env.MediaSession.prototype.setActionHandler.name, nativeName);
  assert.equal(env.nativeCalls.length, 0);
});

/**
 * 自动画中画 - Auto PiP on Tab Switch - MAIN world 桥接脚本
 *
 * 必须在 document_start 跑在 MAIN world 里，并早于页面脚本：目标是在任何网站
 * 代码注册 Media Session 动作处理器之前先接管 MediaSession.prototype.setActionHandler。
 *
 * 为什么需要它：Chrome 在决定自动浮窗时，会先看页面**此刻**是否注册了
 * enterpictureinpicture 动作处理器（触发时查询，不是注册时查询）：注册了就把动作
 * 派发给页面，没注册才由浏览器自己开窗。接管这个派发点，扩展才能按「切走进入、
 * 返回退出」的语义控制进出，并且拿到浏览器在派发前授予的用户激活 —— 反复进入
 * 所必需的那一步。
 *
 * 规则：
 *   - 包装只用于观察网站注册了什么，每次调用都原样转发给原生方法；
 *   - 网站注册了处理器时就完全让路：不替换、不包裹、不替它决定要不要浮窗；
 *   - 网站没有处理器、且设置允许时，才由我们注册的 dispatcher 接住，转成 DOM
 *     事件交给 isolated world 的 content script 决定；
 *   - 设置关闭时撤回我们的 dispatcher，网站自己的处理器原样保留。
 *
 * 这里不能使用任何 chrome.* API —— MAIN world 没有扩展上下文。
 *
 * 整个脚本包在函数里：MAIN world 就是页面自己的世界，顶层 const / function 会变成
 * 全局绑定，可能和页面重名并让桥接直接失效。
 */
void (function installNativePipBridge() {
  'use strict';

  const CONFIG_EVENT = 'auto-pip:config';
  const READY_EVENT = 'auto-pip:bridge-ready';
  const ENTER_EVENT = 'auto-pip:enter';
  const MANUAL_EVENT = 'auto-pip:manual-toggle';
  const STATE_EVENT = 'auto-pip:native-state';
  const PIP_ACTION = 'enterpictureinpicture';

  const sessionPrototype =
    typeof MediaSession !== 'undefined' && MediaSession ? MediaSession.prototype : null;
  if (!sessionPrototype || typeof navigator === 'undefined' || !navigator.mediaSession) return;

  // 只服务于这个 realm 的 mediaSession：任何其它 receiver 一律原样转发，
  // 绝不把它当成「网站注册的处理器」记下来。
  const capturedSession = navigator.mediaSession;

  const originalDescriptor = Object.getOwnPropertyDescriptor(sessionPrototype, 'setActionHandler');
  if (!originalDescriptor || typeof originalDescriptor.value !== 'function') return;
  const original = originalDescriptor.value;

  /* ------------------------------------------------------------ 内部状态 -- */

  let siteHandler = null;
  // 「浏览器侧现在有没有我们的 dispatcher」，必须和上面那次 original 调用同步更新。
  let dispatcherRegistered = false;
  let allowed = false;

  /* ------------------------------------------------------------ 事件通道 -- */

  function sendEvent(type, detail) {
    try {
      const event = new CustomEvent(type, { detail, bubbles: false, cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    } catch (_) {
      return false;
    }
  }

  function announce() {
    sendEvent(STATE_EVENT, {
      site: Boolean(siteHandler),
      dispatcher: dispatcherRegistered,
      allowed
    });
  }

  /* -------------------------------------------------------- dispatcher 注册 -- */

  function bridgeDispatcher() {
    // Chrome 153 实测不会把 details.reason 传给页面回调，连正常工作的站点
    // handler 也拿不到。因此这里用可靠的页面语境分流：隐藏中的回调按自动
    // 进入处理，交由 content script 再向后台确认是否真的切了标签页；可见时
    // 才按媒体键/系统媒体面板的手动切换处理。
    if (document.visibilityState === 'hidden') {
      sendEvent(ENTER_EVENT, {});
      return;
    }
    sendEvent(MANUAL_EVENT, {});
  }

  /** 只在浏览器侧确实没有 handler 时注册，成功后才改状态，失败留待下次重试。 */
  function registerDispatcher() {
    if (dispatcherRegistered || siteHandler) return;
    try {
      original.call(capturedSession, PIP_ACTION, bridgeDispatcher);
    } catch (_) {
      announce();
      return;
    }
    dispatcherRegistered = true;
    announce();
  }

  /** 只改状态、不碰浏览器：网站那次注册已经把浏览器侧覆盖掉了。 */
  function forgetDispatcher() {
    if (dispatcherRegistered) dispatcherRegistered = false;
    // 之前有没有我们的注册都要广播：网站从此接管派发，isolated world 必须知道。
    announce();
  }

  function unregisterDispatcher() {
    if (!dispatcherRegistered) return;
    original.call(capturedSession, PIP_ACTION, null);
    dispatcherRegistered = false;
    announce();
  }

  function applyAllowance() {
    if (allowed && !siteHandler) {
      registerDispatcher();
      return;
    }
    // unregisterDispatcher() 在没有我们自己的注册时是空操作，但 allowed 刚变了，
    // isolated world 仍然需要收到新状态。
    if (!dispatcherRegistered) announce();
    else unregisterDispatcher();
  }

  /* -------------------------------------------------- setActionHandler 包装 -- */

  function wrappedSetActionHandler(action, handler) {
    // 只关心这一个动作，且只关心这个 realm 的 mediaSession。
    if (action !== PIP_ACTION || this !== capturedSession) {
      return original.apply(this, arguments);
    }

    // 先如实转发，并且保留实参个数：原生方法靠参数个数区分「少传参数」的
    // TypeError 与「传 null 撤回」，补成显式 undefined 会改变它的语义。
    const result = original.apply(this, arguments);

    if (typeof handler === 'function') {
      siteHandler = handler;
      // 浏览器侧已被这次调用覆盖成网站的处理器，这里只能改状态；若去调
      // unregister 会把网站刚注册的处理器一起清掉。
      forgetDispatcher();
      return result;
    }

    // handler 为 null：浏览器侧已清空，我们的记录同样归零，否则 applyAllowance()
    // 会以为 dispatcher 还在，再也不会重新注册。
    siteHandler = null;
    dispatcherRegistered = false;
    if (allowed) registerDispatcher();
    else announce();
    return result;
  }

  const installed = (() => {
    try {
      Object.defineProperty(sessionPrototype, 'setActionHandler', {
        value: wrappedSetActionHandler,
        writable: true,
        configurable: true,
        enumerable: originalDescriptor.enumerable
      });
      return true;
    } catch (_) {
      // Object.defineProperty 的失败可能发生在写入之后（属性设好了，返回值复制
      // 出错），此时直接赋值会静默回滚已经生效的包装 —— 所以先确认包装在不在。
      return sessionPrototype.setActionHandler === wrappedSetActionHandler;
    }
  })();
  if (!installed) {
    try {
      sessionPrototype.setActionHandler = wrappedSetActionHandler;
    } catch (_) {
      return;
    }
    if (sessionPrototype.setActionHandler !== wrappedSetActionHandler) return;
  }

  /* ---------------------------------------------------------------- 设置 -- */

  document.addEventListener(CONFIG_EVENT, (event) => {
    const detail = event && event.detail ? event.detail : {};
    allowed = Boolean(detail.enabled && detail.exitOnReturn);
    applyAllowance();
  });

  // 两个 world 的执行顺序没有保证：content script 可能先广播过设置。喊一声 ready
  // 让它重发一次，避免设置丢掉。
  sendEvent(READY_EVENT, {});
  announce();
})();

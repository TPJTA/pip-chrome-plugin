/**
 * 自动画中画 · Auto PiP on Tab Switch — 内容脚本
 *
 * 在每个 frame 里运行（all_frames），职责：
 *   1. 找到「正在播放」的视频（暂停的、只做了铺垫的、装饰性背景动画都不算）
 *   2. 页面隐藏时向后台确认是否切换了标签页
 *   3. 后台核对是否切标签页，清理误触发或返回期间完成的浮窗
 *   4. 回到标签页时按设置决定是否退出画中画
 *   5. 响应控制面板的状态查询与手动切换
 *   6. 接住 MAIN world 桥接脚本转来的「浏览器自动画中画」回调
 */
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true, // 主开关：切标签页时是否自动进入画中画
    exitOnReturn: true // 回到该标签页时是否自动退出画中画
  };

  let settings = { ...DEFAULTS };
  let needsGesture = false;
  let entering = null;
  let visibilityVersion = 0;
  let exiting = null;
  let operationVersion = 0;
  let autoSuppressed = false;
  let lastVisibility = document.visibilityState;
  let lastError = null;
  let nativeAutoPip = { siteHandler: false, dispatcher: false, allowed: false };
  let nativeEntryInFlight = false;
  // 最近一次「自动」进入的来源。它决定返回可见态后由谁负责收尾：
  //   'native-auto'（浏览器派发）、'site-owned'（站点自己的 media session handler）
  //   与 null 都由浏览器自动 leave 收尾，扩展只负责复位；
  //   'extension'（扩展隐藏分支 fallback）才需要在返回后显式退出。
  //
  // 可见态那次 exitPictureInPicture() 之所以不能立即调用：在可见态下它会永久
  // 挂起、把退出状态占死（docs/pip-debug-log.md F2/F14/E22）。因此这里把它推迟到
  // 「页面重新可见、重新获得焦点、连续两帧 rAF、再 300ms」之后，并在等待期间随时
  // 允许取消（页面又隐藏、或浏览器已经自己 leave）。
  // 注释里的 E29 记录了这个「等待窗口」测量到的事实：原生 leave 往往就发生在
  // 这个窗口里，等到窗口结束 PiP 已经为空，于是根本不需要再调用退出 API。
  let lastEntryOrigin = null;

  // 推迟的可见态退出：只保留两个状态。
  //   visibleExitGeneration 每轮可见/隐藏推进都 +1，等待中的那一轮一旦发现自己的
  //     generation 不再是最新就整体作废；「这一轮属于谁」只看可见态那一刻捕获的
  //     origin 快照，不看任何跨轮的判重标志。
  //   delayedExitInFlight 记下正在飞的那次退出属于哪个 generation，用来保证同一轮
  //     只调用一次 document.exitPictureInPicture()。
  let visibleExitGeneration = 0;
  let delayedExitInFlight = null;

  // 站点自己注册了 enterpictureinpicture handler 时，进入/退出都归站点与浏览器
  // 调度。这一轮扩展既不抢着开窗（会与站点 handler 竞争，改变站点语义），也不在
  // 返回时替它退出（可见态 exit 调用会挂起，见 F2/F14）；只等浏览器自动 leave。
  function siteOwnsAutoEntry() {
    return nativeAutoPip.siteHandler && !nativeAutoPip.dispatcher;
  }

  // 桥接脚本只在顶层框架里运行（自动画中画的触发方也是顶层框架）。
  const isTopFrame = window.top === window;

  function cancelAutomaticEntry() {
    autoSuppressed = true;
    operationVersion++;
  }

  /**
   * 把「退出相关」的本地状态整体复位。
   *
   * exiting 只在我们自己发起的退出里被赋值；这里允许直接清空，是因为调用方
   * 都已经确认过窗口真的没了（只有跳过调用、浏览器自动 leave 和本地兜底超时
   * 这三种情形）。等待中的延迟退出由 generation 作废，不会再改写新一轮状态。
   */
  function resetExitState() {
    exiting = null;
    autoSuppressed = false;
    lastError = null;
  }

  /**
   * 窗口真的关掉了（用户、站点或浏览器自己关的）—— 这一轮到此终止。
   *
   * 判据只取事件发生那一刻的实时状态：窗口还在不在。三种来源必须一视同仁地
   * 清理，包括来源为 'extension'、此刻正处在可见态稳定窗口里的那种：那时
   * `exiting` 还是 null，只看 exiting 就会漏掉，把 'extension' 留在原地，让下一轮
   * 误以为是扩展自己开的窗口。
   *
   * 正在等待中的那一轮由 generation 作废：等待窗口跑完时会发现自己的 generation
   * 已经过期，直接返回，不会去动新一轮的任何状态。
   */
  document.addEventListener('leavepictureinpicture', () => {
    // 窗口还在（leave 与新一轮进入交错）：这是「用户刚关过窗口」那条语义，
    // 本轮隐藏期间不得重新打开；来源必须保留，否则会误伤新一轮。
    if (document.pictureInPictureElement) {
      cancelAutomaticEntry();
      return;
    }
    visibleExitGeneration++;
    lastEntryOrigin = null;
    delayedExitInFlight = null;
    // 页面在后台时用户手动关窗：本轮隐藏周期的后台复核答复可能还在飞，答复回来
    // 会照常请求进入，把用户刚关掉的窗口又开出来。这里按「刚关过窗口」的同一语义
    // 作废本轮：推进 visibilityVersion 让在飞的答复与隐藏分支整体失效，并保持
    // autoSuppressed=true，后续任何自动进入都要等下一次从 visible 进入 hidden
    // （那时才复位）。复位动作因此不能走 resetExitState()，它会顺手清掉抑制标记。
    if (document.visibilityState === 'hidden') {
      cancelAutomaticEntry();
      visibilityVersion++;
      exiting = null;
      lastError = null;
      return;
    }
    resetExitState();
  }, true);

  /* ------------------------------------------------------------ 设置同步 -- */

  /**
   * 把开关状态同步给 MAIN world 的桥接脚本。
   *
   * 桥接脚本只能通过 DOM 事件拿到设置：它跑在页面自己的世界里，没有
   * chrome.* 上下文。isTrusted 不会被伪造，但这里刻意不用它做安全判断 ——
   * 页面自己也能派发同名事件，因此桥接侧只把它当作「开关状态」，任何
   * 由它触发的实际进出仍然要回到后台核对一次。
   */
  function broadcastConfig() {
    if (!isTopFrame) return;
    try {
      document.dispatchEvent(
        new CustomEvent('auto-pip:config', {
	  detail: { enabled: settings.enabled, exitOnReturn: settings.exitOnReturn },
          bubbles: false,
          cancelable: false
        })
      );
    } catch (_) {
      /* 文档正在拆除时忽略 */
    }
  }

  // 桥接脚本装好监听后会喊一声 ready。两个 world 的执行顺序没有保证，所以
  // 收到它就把当前设置重发一次；设置还没读出来时先不发，等读完那次广播。
  document.addEventListener('auto-pip:bridge-ready', () => {
    if (configSent) broadcastConfig();
  });

  let configSent = false;

  try {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      if (!chrome.runtime.lastError && stored) settings = { ...DEFAULTS, ...stored };
      configSent = true;
      broadcastConfig();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let touched = false;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULTS) {
          settings[key] = changes[key].newValue;
          touched = true;
        }
      }
      if (touched) broadcastConfig();
    });
  } catch (_) {
    /* 扩展被重新加载后旧脚本会失去上下文，保持默认值即可 */
  }

  /* -------------------------------------------------------------- 视频检测 -- */

  /** 只认真正在播的视频：未暂停、未结束、元数据就绪、有画面。 */
  function isPlaying(video) {
    return (
      !video.paused &&
      !video.ended &&
      video.readyState > 2 &&
      video.currentTime > 0 &&
      video.videoWidth > 0
    );
  }

  function collectVideos() {
    const normal = Array.from(document.querySelectorAll('video'));
    if (normal.length) return normal;

    // 页面里没有 <video> 时才去翻开放的 Shadow DOM（成本较高，故按需触发）
    const shadow = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) shadow.push(...el.shadowRoot.querySelectorAll('video'));
    }
    return shadow;
  }

  /**
   * 给候选视频打分，避免挑中装饰性视频（背景动画、粒子、循环 banner）。
   * 有声音、时长较长、面积大、位于视口内的优先级更高。
   */
  function scoreVideo(video) {
    let value = 0;
    const rect = video.getBoundingClientRect();

    if (!video.muted && video.volume > 0) value += 1000;
    if (video.duration > 60) value += 500;
    else if (video.duration > 10) value += 300;

    value += Math.min((rect.width * rect.height) / 1000, 500);
    if (
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
    ) {
      value += 200;
    }
    value += Math.min(video.currentTime, 100);
    return value;
  }

  /** 挑出当前最值得浮窗的那个视频，没有则返回 null。 */
  function pickVideo() {
    let best = null;
    let bestScore = -Infinity;

    for (const video of collectVideos()) {
      if (!isPlaying(video) || video.disablePictureInPicture) continue;
      const rect = video.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      const value = scoreVideo(video);
      if (value > bestScore) {
        bestScore = value;
        best = video;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ 画中画操作 -- */

  function enterPictureInPicture({ automatic = false } = {}) {
    // 主开关只拦「自动」进入。用户显式点的按钮、按的媒体键属于手动操作，
    // 关掉自动进入不该让它们失灵（面板上的按钮一直可见，媒体键也一直可用）。
    if (automatic && !settings.enabled) return Promise.resolve(false);
    if (!document.pictureInPictureEnabled) return Promise.resolve(false);
    if (exiting || (automatic && autoSuppressed)) return Promise.resolve(false);
    if (entering) return entering;
    if (document.pictureInPictureElement) return Promise.resolve(true);

    const video = pickVideo();
    if (!video) return Promise.resolve(false);

    const version = operationVersion;
    // 普通 PiP 仍受浏览器短暂用户激活限制，不接管网站的媒体会话。
    entering = (async () => {
      try {
        await video.requestPictureInPicture();
        needsGesture = false;
        lastError = null;
        // 退出优先于尚未完成的进入请求，且无需等待后台核对结果。
        if (version !== operationVersion) {
          if (document.pictureInPictureElement === video) await exitPictureInPicture();
          return false;
        }
        const returned = document.visibilityState === 'visible' && settings.exitOnReturn;
        if (version !== operationVersion || (automatic && (!settings.enabled || returned))) {
          // 只清理本次打开的视频，避免关闭页面后来打开的其他画中画。
          if (document.pictureInPictureElement === video) await exitPictureInPicture();
          return false;
        }
        return true;
      } catch (error) {
        needsGesture = error?.name === 'NotAllowedError';
        lastError = error?.name || 'enter-failed';
        return false;
      }
    })();
    const request = entering;
    request.finally(() => {
      if (entering === request) entering = null;
    });
    return request;
  }

  /**
   * 扩展主动发起一次退出。
   *
   * 控制面板、媒体键与可见态稳定窗口结束后的延迟退出都走这一条。调用方的超时
   * 兜底只需要在「永不结算」时解除本地占位；真正的窗口状态始终以
   * `document.pictureInPictureElement` 为准。
   */
  function exitPictureInPicture() {
    cancelAutomaticEntry();
    if (exiting) return exiting;
    if (!document.pictureInPictureElement) return Promise.resolve(true);
    exiting = (async () => {
      try {
        await document.exitPictureInPicture();
        const ok = !document.pictureInPictureElement;
        lastError = ok ? null : 'exit-failed';
        return ok;
      } catch (error) {
        // 另一条退出路径可能已关闭窗口；否则必须向面板报告真实失败。
        if (!document.pictureInPictureElement) return true;
        lastError = error?.name || 'exit-failed';
        return false;
      }
    })();
    const request = exiting;
    request.finally(() => {
      if (exiting === request) exiting = null;
    });
    return request;
  }

  async function togglePictureInPicture() {
    if (document.pictureInPictureElement || entering || exiting) {
      const pending = entering;
      const ok = await exitPictureInPicture();
      // 若打开尚未完成，由进入请求的版本检查负责收回，再返回真实状态。
      if (pending) await pending;
      return { ok: ok && !document.pictureInPictureElement, state: currentState(),
        reason: document.pictureInPictureElement ? 'exit-failed' : null, error: lastError };
    }
    const ok = await enterPictureInPicture();
    return { ok, state: currentState(),
      reason: ok ? null : needsGesture ? 'needs-gesture' : 'no-video', error: lastError };
  }

  /* -------------------------------------------------- 浏览器自动画中画回调 -- */

  /**
   * 浏览器判定到了自动画中画时机时，会把这个动作派发给页面。桥接脚本把它
   * 转成这个 DOM 事件，我们在这里决定进出。
   *
   * 进入前必须回后台核对一次「确实切了标签页」：这个动作也可能来自媒体键等
   * 别的时机，只有后台确认切换过标签页才允许开窗，否则切应用会误触发。
   *
   * 这次 await 是安全的：`MediaSession::DidReceiveAction` 在派发动作前会先给
   * 框架一次用户激活通知，而它跨任务依然有效，所以回到这里再调用
   * requestPictureInPicture() 不会因为缺少用户激活被拒。
   */
  document.addEventListener('auto-pip:enter', async (event) => {
    if (!isTopFrame) return;
    if (event && event.defaultPrevented) return;
    if (!settings.enabled || !settings.exitOnReturn) return;

    // 只做时序保护，不占用 visibilitychange 的版本号：两条路径可能同时被唤醒，
    // 但决定进出的请求应该由它们各自的最新状态说了算，而不是互相作废。
    const version = visibilityVersion;
    if (!pickVideo()) return;

    nativeEntryInFlight = true;
    try {
      const reply = await askServiceWorker({ type: 'pageHidden' });
      if (version !== visibilityVersion || autoSuppressed) return;
      // 自动画中画只在标签页**被遮挡**时才该进入。这里若已经回到前台（收回复核
      // 结果的过程中用户切了回来），本次自动进入就作废，由 visibilitychange 那条
      // 路径按「返回时自动退出」处理。
      if (document.visibilityState !== 'hidden') return;
      // 全程记下这次进入来自浏览器原生派发，返回时才能按「交给浏览器关闭」处理。
      lastEntryOrigin = 'native-auto';
      if (reply && reply.tabSwitch) await enterPictureInPicture({ automatic: true });
    } finally {
      nativeEntryInFlight = false;
    }
  });

  /**
   * 同一个动作在其它时机到达（用户按媒体键、系统媒体面板等）。这里保持
   * 与面板按钮一致的「切换」语义，并且在关闭自动进入时也照常工作 ——
   * 用户显式操作不应该被扩展的开关拦住。
   */
  document.addEventListener('auto-pip:manual-toggle', (event) => {
    if (!isTopFrame) return;
    if (event && event.defaultPrevented) return;
    void togglePictureInPicture();
  });

  /** 桥接脚本每次改变自己的注册状态就广播一次，供面板解释当前生效的路径。 */
  document.addEventListener('auto-pip:native-state', (event) => {
    const detail = (event && event.detail) || {};
    nativeAutoPip = {
      siteHandler: Boolean(detail.site),
      dispatcher: Boolean(detail.dispatcher),
      allowed: Boolean(detail.allowed)
    };
  });

  /* ---------------------------------------------------------------- 通信 -- */

  function askServiceWorker(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(reply);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  function currentState() {
    if (document.pictureInPictureElement) return 'pip';
    return pickVideo() ? 'playing' : 'idle';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;

    if (message.type === 'pip:status') {
      sendResponse({
        enabled: settings.enabled,
        state: currentState(),
        pipAvailable: !!document.pictureInPictureEnabled,
        needsGesture,
        lastError,
        exitOnReturn: settings.exitOnReturn,
        nativeAutoPip: { ...nativeAutoPip },
        lastEntryOrigin,
        // 可见态等待窗口只看两个值：本轮属于哪个 generation，以及那一刻捕获的
        // 进入来源。delayedExitInFlight 只在扩展确实调用退出 API 时落位，用来保证
        // 同一轮只调用一次；跳过的轮次它始终为 null。
        deferredExit: {
          generation: visibleExitGeneration,
          delayedExitInFlight
        }
      });
      return undefined;
    }

    if (message.type === 'pip:toggle') {
      void togglePictureInPicture().then(sendResponse);
      return true; // 异步回复
    }

    return undefined;
  });

  // content.js 自己不碰 Media Session：注册与撤回都在 MAIN world 的
  // native-pip-bridge.js 里完成，且每次调用都如实转发给页面自己的实现。

  /* ------------------------------------------------------------ 主流程 -- */

  // 等待窗口的三个参数。300ms 是 root 批准的量（E29 已用它测量过原生 leave 发生的
  // 时机）；两个参数是纯粹的防御上界，用来保证任何情况下都能走到判定，不会挂死。
  const STABLE_FRAMES = 2;
  const STABLE_DELAY_MS = 300;
  const STABLE_FOCUS_TIMEOUT_MS = 2000;
  const EXIT_PROMISE_TIMEOUT_MS = 2000;
  // 隐藏态里给站点自己的 enterpictureinpicture handler 的优先窗口：站点在这段时间
  // 内没开窗，扩展才按普通路径兜底进入（见 hidden 分支）。
  const SITE_PRIORITY_WINDOW_MS = 1000;

  /** 等页面重新拿到焦点；超时返回 false，由调用方在快照里如实记录。 */
  function waitForFocus(timeoutMs) {
    // hasFocus() 在极老的 Chrome 上没有；缺了就当作「已经聚焦」，让等待窗口照常走完。
    if (typeof document.hasFocus !== 'function' || document.hasFocus()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const onFocus = () => { cleanup(); resolve(true); };
      const timer = setInterval(() => {
        if (Date.now() > deadline) {
          cleanup();
          resolve(false);
        }
      }, 40);
      function cleanup() {
        window.removeEventListener('focus', onFocus);
        window.clearInterval(timer);
      }
      window.addEventListener('focus', onFocus);
    });
  }

  /** 连续两帧 rAF：确认页面真的在渲染，而不是停在不可见的挂起状态里。 */
  function nextFrame() {
    if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  /**
   * 等到「页面可见 + 重新获得焦点 + 连续两帧 rAF + 300ms 稳定」之后再决定是否退出。
   *
   * 窗口结束时逐项检查（任何一项不成立就直接返回，不动任何状态）：
   *   - generation 是否仍是最新（新一轮 hidden/visible 会作废本轮）
   *   - 页面是否仍是 visible（用户马上又切走了，本轮不再由我们收尾）
   *   - PiP 是否仍在（空即视为浏览器/站点已经自己关掉，本轮到此为止）
   *   - 设置是否仍要求返回时退出
   *
   * 是否由扩展动手，只看可见态那一刻捕获的 origin 快照：'native-auto'、'site-owned'
   * 与 null 都交给浏览器自动 leave；只有 'extension'（扩展自己 fallback 开的
   * 窗口）才调用一次 `document.exitPictureInPicture()`。绝不因为「窗口还开着」就
   * 替浏览器或站点收尾。
   */
  async function deferredVisibleExit(generation, origin) {
    await waitForFocus(STABLE_FOCUS_TIMEOUT_MS);
    for (let frame = 0; frame < STABLE_FRAMES; frame++) await nextFrame();
    await new Promise((resolve) => setTimeout(resolve, STABLE_DELAY_MS));

    // 只给*本轮*收尾。新一轮 hidden/visible、浏览器自动 leave 都会推进 generation，
    // 这里的结论随即失效，直接返回，绝不改写新一轮的任何状态。
    if (generation !== visibleExitGeneration) return;
    if (document.visibilityState !== 'visible') return;
    // 已为空：浏览器（或站点）已经自己关掉了，清理状态、不调用退出 API。
    if (!document.pictureInPictureElement) {
      resetExitState();
      return;
    }
    if (!settings.exitOnReturn) return;
    // 原生自动画中画与站点自有的窗口都由浏览器自动 leave 收尾，扩展只等。
    if (origin !== 'extension') return;

    // 到这里才允许动手，且全程只调用一次 document.exitPictureInPicture()。
    if (delayedExitInFlight !== null) return;
    delayedExitInFlight = generation;
    const request = exitPictureInPicture();
    // promise 可能永不结算（F2/F14/E22）：2s 竞速只为解开本地占位，不重试。
    await Promise.race([
      request.then(
        () => true,
        () => false
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), EXIT_PROMISE_TIMEOUT_MS))
    ]);
    // 身份检查：只有 generation 仍匹配时才释放占位与 exiting，否则可能误伤新一轮。
    if (generation !== visibleExitGeneration) return;
    if (delayedExitInFlight === generation) delayedExitInFlight = null;
    if (exiting === request) resetExitState();
  }

  document.addEventListener('visibilitychange', async () => {
    const version = ++visibilityVersion;
    const wasVisible = lastVisibility === 'visible';
    lastVisibility = document.visibilityState;
    if (wasVisible && lastVisibility === 'hidden') autoSuppressed = false;
    if (document.visibilityState === 'visible') {
      // 关键：这里**不能**直接调用 document.exitPictureInPicture()。可见态下它会永久
      // 挂起，把退出状态占死（F2/F14/E22）。交给 deferredVisibleExit() 等页面稳定
      // 之后再判断：浏览器原生自动画中画与站点自己开的窗口通常在这段时间里被浏览器
      // 自己关掉（E29 测得原生 leave 就落在 300ms 窗口内），那时已经无需我们再动手。
      // generation 与来源快照都在这里一次性捕获：此后「这一轮属于谁」只看这两个
      // 局部值，任何自动 leave / 状态复位都不会改写它们。
      const generation = ++visibleExitGeneration;
      void deferredVisibleExit(generation, lastEntryOrigin);
      return;
    }

    // 又切走了：本轮可见态推进整体作废（等待中的回调会因 generation 不符而放弃）。
    visibleExitGeneration++;

    if (!settings.enabled) return;
    if (!pickVideo()) return; // 需求①：只有视频在播放时才处理

    // 站点自己持有 enterpictureinpicture handler 时，先让站点/浏览器有一个优先
    // 窗口：这段时间内扩展不抢着开窗，避免与站点 handler 竞争、改变站点语义。
    // 窗口内窗口已经出现就维持站点所有权（返回时也交给浏览器自动 leave 收尾）；
    // 窗口结束仍是空的，才走下面的既有 pageHidden 验证，按普通路径兜底进入。
    if (siteOwnsAutoEntry()) {
      lastEntryOrigin = 'site-owned';
      const deadline = Date.now() + SITE_PRIORITY_WINDOW_MS;
      while (Date.now() < deadline) {
        if (version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed) return;
        if (document.pictureInPictureElement) return; // 站点自己开好了，扩展全程不介入
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed) return;
      if (document.pictureInPictureElement) return;
      // 站点这次没有开窗：不覆盖、不清除它的 handler，只在下面按扩展自己的
      // 兜底路径进入，进入前把来源改记为 extension，返回时由扩展负责退出。
    }

    // 桥接已注册时先等浏览器原生自动画中画。它比旧路径多拿到一次用户激活，
    // 连续切换才可靠；但“支持回调”不等于“本轮一定有资格”，所以超时后仍走旧
    // 路径兜底，而不是永久关掉它。
    if (nativeAutoPip.dispatcher && nativeAutoPip.allowed) {
      const deadline = Date.now() + 700;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed) return;
        if (nativeEntryInFlight || entering || document.pictureInPictureElement) return;
      }
    }

    const reply = await askServiceWorker({ type: 'pageHidden' });
    if (version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed) return;
    if (reply && reply.tabSwitch) {
      lastEntryOrigin = 'extension';
      await enterPictureInPicture({ automatic: true });
    }
  });
})();

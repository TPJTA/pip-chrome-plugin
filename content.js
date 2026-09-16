/**
 * 自动画中画 · Auto PiP on Tab Switch — 内容脚本
 *
 * 在每个 frame 里运行（all_frames），职责：
 *   1. 找到「正在播放」的视频（暂停的、只做了铺垫的、装饰性背景动画都不算）
 *   2. 优先响应浏览器的自动画中画回调，旧浏览器使用 visibilitychange
 *   3. 后台核对是否切标签页，清理误触发或返回期间完成的浮窗
 *   4. 回到标签页时按设置决定是否退出画中画
 *   5. 响应控制面板的状态查询与手动切换
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
  let nativeAutoPip = false;
  let exiting = null;
  let operationVersion = 0;
  let autoSuppressed = false;
  let lastVisibility = document.visibilityState;
  let lastError = null;

  function cancelAutomaticEntry() {
    autoSuppressed = true;
    operationVersion++;
  }

  // 用户通过视频菜单或浮窗关闭按钮退出后，本轮隐藏期间不得重新打开。
  document.addEventListener('leavepictureinpicture', cancelAutomaticEntry, true);

  /* ------------------------------------------------------------ 设置同步 -- */

  try {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      if (!chrome.runtime.lastError && stored) settings = { ...DEFAULTS, ...stored };
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) {
        if (key in DEFAULTS) settings[key] = changes[key].newValue;
      }
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

  function enterPictureInPicture({ automatic = false, verifyTab = false } = {}) {
    if (!settings.enabled || !document.pictureInPictureEnabled) return Promise.resolve(false);
    if (exiting || (automatic && autoSuppressed)) return Promise.resolve(false);
    if (entering) return entering;
    if (document.pictureInPictureElement) return Promise.resolve(true);

    const video = pickVideo();
    if (!video) return Promise.resolve(false);

    const version = operationVersion;
    // 必须在原生 Media Session 回调内直接请求，不能先等后台消息而丢失激活。
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
        const reply = verifyTab ? await askServiceWorker({ type: 'pageHidden' }) : null;
        const returned = document.visibilityState === 'visible' && settings.exitOnReturn;
        const wrongTab = verifyTab && (!reply || !reply.tabSwitch);
        if (version !== operationVersion || (automatic && (!settings.enabled || returned || wrongTab))) {
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
        nativeAutoPip,
        needsGesture,
        lastError
      });
      return undefined;
    }

    if (message.type === 'pip:toggle') {
      void togglePictureInPicture().then(sendResponse);
      return true; // 异步回复
    }

    return undefined;
  });

  /* ------------------------------------------------------ 原生自动画中画 -- */

  // 原生自动画中画只支持顶层媒体。子 frame 保留普通 API 路径。
  // 不做「进入再退出」预热：普通 PiP 请求会消耗短暂激活，无法永久解锁。
  if (window.top === window && navigator.mediaSession && document.pictureInPictureEnabled) {
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture', (details) => {
        if (details.reason === 'contentoccluded') {
          if (!settings.enabled) return;
          // Chrome 原生自动 PiP 会在返回时关闭。需要保留浮窗时用旧路径。
          if (!settings.exitOnReturn || document.visibilityState !== 'hidden') return;
          void enterPictureInPicture({ automatic: true, verifyTab: true });
        } else if (details.reason === 'other') {
          // 手动按钮是切换操作，已有窗口时必须退出，不能只调用进入函数。
          void togglePictureInPicture();
        }
      });
      nativeAutoPip = true;
    } catch (_) {
      // 旧版 Chrome 不支持这个 action，保留需要短暂用户激活的路径。
    }
  }

  /* ------------------------------------------------------------ 主流程 -- */

  document.addEventListener('visibilitychange', async () => {
    const version = ++visibilityVersion;
    const wasVisible = lastVisibility === 'visible';
    lastVisibility = document.visibilityState;
    if (wasVisible && lastVisibility === 'hidden') autoSuppressed = false;
    if (document.visibilityState === 'visible') {
      if (settings.exitOnReturn) await exitPictureInPicture();
      return;
    }

    if (!settings.enabled) return;
    // 避免普通请求抢先消耗激活，或与浏览器原生回调同时打开浮窗。
    if (nativeAutoPip && settings.exitOnReturn) return;
    if (!pickVideo()) return; // 需求①：只有视频在播放时才处理

    const reply = await askServiceWorker({ type: 'pageHidden' });
    if (version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed) return;
    if (reply && reply.tabSwitch) await enterPictureInPicture({ automatic: true });
  });
})();

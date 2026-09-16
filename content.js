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
    if (entering) return entering;
    if (document.pictureInPictureElement) return Promise.resolve(true);

    const video = pickVideo();
    if (!video) return Promise.resolve(false);

    // 必须在原生 Media Session 回调内直接请求，不能先等后台消息而丢失激活。
    entering = (async () => {
      try {
        await video.requestPictureInPicture();
        needsGesture = false;
        const reply = verifyTab ? await askServiceWorker({ type: 'pageHidden' }) : null;
        const returned = document.visibilityState === 'visible' && settings.exitOnReturn;
        const wrongTab = verifyTab && (!reply || !reply.tabSwitch);
        if (automatic && (!settings.enabled || returned || wrongTab)) {
          // 只清理本次打开的视频，避免关闭页面后来打开的其他画中画。
          if (document.pictureInPictureElement === video) await exitPictureInPicture();
          return false;
        }
        return true;
      } catch (error) {
        needsGesture = error?.name === 'NotAllowedError';
        return false;
      }
    })();
    const request = entering;
    request.finally(() => {
      if (entering === request) entering = null;
    });
    return request;
  }

  async function exitPictureInPicture() {
    if (!document.pictureInPictureElement) return;
    try {
      await document.exitPictureInPicture();
    } catch (_) {
      /* 视频可能已被用户手动关闭浮窗 */
    }
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
        needsGesture
      });
      return undefined;
    }

    if (message.type === 'pip:toggle') {
      (async () => {
        if (document.pictureInPictureElement) {
          await exitPictureInPicture();
          sendResponse({ ok: true, state: currentState() });
          return;
        }
        const ok = await enterPictureInPicture();
        sendResponse({
          ok,
          state: currentState(),
          reason: ok ? null : needsGesture ? 'needs-gesture' : 'no-video'
        });
      })();
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
        if (!settings.enabled) return;
        if (details.reason === 'contentoccluded') {
          // Chrome 原生自动 PiP 会在返回时关闭。需要保留浮窗时用旧路径。
          if (!settings.exitOnReturn || document.visibilityState !== 'hidden') return;
          void enterPictureInPicture({ automatic: true, verifyTab: true });
        } else {
          // 浏览器媒体控件中的手动画中画操作。
          void enterPictureInPicture();
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
    if (document.visibilityState === 'visible') {
      if (settings.exitOnReturn) await exitPictureInPicture();
      return;
    }

    if (!settings.enabled) return;
    // 避免普通请求抢先消耗激活，或与浏览器原生回调同时打开浮窗。
    if (nativeAutoPip && settings.exitOnReturn) return;
    if (!pickVideo()) return; // 需求①：只有视频在播放时才处理

    const reply = await askServiceWorker({ type: 'pageHidden' });
    if (version !== visibilityVersion || document.visibilityState !== 'hidden') return;
    if (reply && reply.tabSwitch) await enterPictureInPicture({ automatic: true });
  });
})();

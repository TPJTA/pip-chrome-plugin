/**
 * 自动画中画 · Auto PiP on Tab Switch — 内容脚本
 *
 * 在每个 frame 里运行（all_frames），职责：
 *   1. 找到「正在播放」的视频（暂停的、只做了铺垫的、装饰性背景动画都不算）
 *   2. 页面变为不可见时，问后台这是不是一次「切标签页」
 *   3. 是 → 请求进入画中画；不是（切应用 / 最小化）→ 什么都不做
 *   4. 回到标签页时按设置决定是否退出画中画
 *   5. 响应控制面板的状态查询与手动切换
 */
(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true, // 主开关：切标签页时是否自动进入画中画
    exitOnReturn: true, // 回到该标签页时是否自动退出画中画
    compatPriming: false // 兼容模式：必要时做一次「手势预热」
  };

  let settings = { ...DEFAULTS };
  let needsPriming = false; // 曾经因为缺少用户手势被拒
  let primingAttempted = false;

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

  async function enterPictureInPicture() {
    if (!settings.enabled) return false;
    if (!document.pictureInPictureEnabled) return false;
    if (document.pictureInPictureElement) return true;

    const video = pickVideo();
    if (!video) return false;

    try {
      await video.requestPictureInPicture();
      needsPriming = false;
      return true;
    } catch (error) {
      // Chrome 要求「文档有过用户交互」；记下来，交给兼容模式处理
      if (error && error.name === 'NotAllowedError') needsPriming = true;
      return false;
    }
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
        pipAvailable: !!document.pictureInPictureEnabled
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
          reason: ok ? null : needsPriming ? 'needs-gesture' : 'no-video'
        });
      })();
      return true; // 异步回复
    }

    return undefined;
  });

  /* ------------------------------------------------------ 兼容模式预热逻辑 -- */

  /**
   * 极少数页面（多为自动播放、用户从未点过页面的场景）首次切换会因缺少
   * 用户手势而失败。开启兼容模式后，下一次用户在页面上的交互会做一次
   * 「进入 + 立刻退出」的预热，为后续切换铺路。
   */
  function primeOnGesture() {
    if (!settings.enabled || !settings.compatPriming) return;
    if (!needsPriming || primingAttempted) return;
    if (!document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement) return;

    const video = pickVideo();
    if (!video) return;

    primingAttempted = true;
    (async () => {
      try {
        await video.requestPictureInPicture();
        await document.exitPictureInPicture();
        needsPriming = false;
      } catch (_) {
        primingAttempted = false; // 允许之后的手势再试一次
      }
    })();
  }

  for (const type of ['pointerdown', 'keydown']) {
    document.addEventListener(type, primeOnGesture, true);
  }

  /* ------------------------------------------------------------ 主流程 -- */

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      if (settings.exitOnReturn) await exitPictureInPicture();
      return;
    }

    if (!settings.enabled) return;
    if (!pickVideo()) return; // 需求①：只有视频在播放时才处理

    const reply = await askServiceWorker({ type: 'pageHidden' });
    if (reply && reply.tabSwitch) await enterPictureInPicture();
  });
})();

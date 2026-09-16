/**
 * 自动画中画 · Auto PiP on Tab Switch — 后台 Service Worker
 *
 * 它只负责回答内容脚本的一个问题：页面刚刚变成「不可见」，到底是
 *   ① 用户切到了别的标签页  —— 另一个标签页成了活跃页 → 应该浮窗
 *   ② 用户切到了别的应用    —— 本标签页仍是所在窗口的活跃页 → 不浮窗
 *
 * 之所以查 `chrome.tabs.query({ active: true })` 而不是用
 * `document.hasFocus()`：切换应用同样会让文档失焦，但活跃标签页并不会变，
 * 所以这个判断天然满足了「只响应切标签页」的需求。
 */

const RETRY_DELAY_MS = 60;
const MAX_ATTEMPTS = 3;

/** 读取某个窗口当前的活跃标签页。 */
function getActiveTabIn(windowId) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 返回 true 表示「该标签页已经不再是活跃页」= 用户切走了标签页。
 *
 * Chrome 更新活跃标签页和派发 visibilitychange 基本在同一时刻发生，但先后
 * 顺序没有保证，所以这里做几次短暂重试，避免误判成「窗口失焦」。
 */
async function hasTabBeenSwitchedAway(tab) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const active = await getActiveTabIn(tab.windowId);
    if (active && active.id !== tab.id) return true;
    await wait(RETRY_DELAY_MS);
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;

  if (message.type === 'pageHidden') {
    const tab = sender.tab;
    if (!tab || tab.id == null) {
      sendResponse({ tabSwitch: false });
      return undefined;
    }
    hasTabBeenSwitchedAway(tab).then((switched) => {
      sendResponse({ tabSwitch: switched });
    });
    return true; // 保持通道打开，等待异步结果
  }

  return undefined;
});

/** 首次安装时把默认值写进 storage，让 popup 一打开就有确定状态。 */
chrome.runtime.onInstalled.addListener(() => {
  const DEFAULTS = { enabled: true, exitOnReturn: true };
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    chrome.storage.sync.set(stored);
  });
});

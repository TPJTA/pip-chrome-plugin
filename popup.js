/**
 * 自动画中画 — 控制面板逻辑
 *
 * 两个开关都写进 chrome.storage.sync，content.js 会实时收到变更。
 */

const DEFAULTS = { enabled: true, exitOnReturn: true };

const toggleEls = {
  enabled: document.getElementById('enabled'),
  exitOnReturn: document.getElementById('exitOnReturn')
};

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const testBtn = document.getElementById('test');
const hintEl = document.getElementById('hint');

const STATE_TEXT = {
  pip: '视频已在画中画中',
  playing: '检测到正在播放的视频',
  idle: '未检测到正在播放的视频',
  loading: '正在检测…',
  unsupported: '此页面不支持（浏览器内置页）'
};

let hintTimer = 0;

/* ---------------------------------------------------------------- 工具 -- */

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      resolve({ ...DEFAULTS, ...(stored || {}) });
    });
  });
}

function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

/** 只问主框架（frameId 0），因此内容脚本必须在顶层运行。 */
function sendToPage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (reply) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(reply);
    });
  });
}

function setStatus(state) {
  statusEl.dataset.state = state;
  statusTextEl.textContent = STATE_TEXT[state] || STATE_TEXT.idle;
}

function showHint(text) {
  hintEl.textContent = text;
  hintEl.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintEl.hidden = true;
  }, 6000);
}

/* ------------------------------------------------------------ 状态刷新 -- */

async function refreshStatus() {
  const settings = await getSettings();

  if (!settings.enabled) {
    setStatus('off');
    statusTextEl.textContent = '已关闭 · 不会自动进入画中画';
    return;
  }

  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    setStatus('unsupported');
    return;
  }

  const reply = await sendToPage(tab.id, { type: 'pip:status' });
  if (!reply) {
    setStatus('unsupported');
    return;
  }
  setStatus(reply.state);
  if (reply.needsGesture && reply.state !== 'pip') {
    statusTextEl.textContent = '浏览器要求新的页面交互，请检查自动画中画权限';
  }
}

/* -------------------------------------------------------------- 交互 -- */

for (const [key, el] of Object.entries(toggleEls)) {
  el.addEventListener('change', async () => {
    await chrome.storage.sync.set({ [key]: el.checked });
    if (key === 'enabled') refreshStatus();
  });
}

testBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    showHint('当前页面不支持画中画。');
    return;
  }

  const reply = await sendToPage(tab.id, { type: 'pip:toggle' });
  if (!reply) {
    showHint('当前页面不支持画中画（例如浏览器内置页面）。');
    return;
  }

  await refreshStatus();
  if (reply.ok) return;

  if (reply.reason === 'needs-gesture') {
    showHint('浏览器缺少本次操作所需的用户交互。连续自动浮窗请在网站设置中允许「自动画中画」，并保持视频有声播放。');
  } else {
    showHint('没有检测到正在播放的视频，请先播放视频。');
  }
});

/* --------------------------------------------------------------- 初始化 -- */

(async () => {
  const settings = await getSettings();
  for (const [key, el] of Object.entries(toggleEls)) {
    el.checked = Boolean(settings[key]);
  }
  await refreshStatus();
})();

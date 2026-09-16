import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const manifest = JSON.parse(await readFile(join(projectRoot, 'manifest.json'), 'utf8'));

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const file = request.url === '/other.html' ? 'other.html' : 'video.html';
      const body = await readFile(join(here, 'fixtures', file));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

async function poll(assertion, message, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, interval));
    }
  }
  throw new Error(message, { cause: lastError });
}

async function launchChromium(userDataDir) {
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    `--disable-extensions-except=${projectRoot}`,
    `--load-extension=${projectRoot}`
  ];
  if (process.env.PLAYWRIGHT_HEADLESS === '1') args.push('--headless=new');

  const child = spawn(chromium.executablePath(), args, {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_000);
  });

  const port = await poll(async () => {
    if (child.exitCode != null) throw new Error(`Chromium exited with ${child.exitCode}: ${stderr}`);
    const activePort = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [value] = activePort.trim().split('\n');
    assert.match(value, /^\d+$/);
    return value;
  }, 'Chromium did not expose a DevTools endpoint', { timeout: 15_000 });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const context = browser.contexts()[0];
  assert.ok(context, 'Playwright did not discover Chromium default context');
  return { browser, context, child };
}

async function getSetting(serviceWorker, key) {
  return serviceWorker.evaluate((storageKey) => new Promise((resolveStorage) => {
    chrome.storage.sync.get([storageKey], (stored) => resolveStorage(stored[storageKey]));
  }), key);
}

async function setSetting(serviceWorker, key, value) {
  await serviceWorker.evaluate(({ storageKey, storageValue }) =>
    chrome.storage.sync.set({ [storageKey]: storageValue }),
  { storageKey: key, storageValue: value });
}

async function getExtensionServiceWorker(context) {
  return poll(async () => {
    for (const worker of context.serviceWorkers()) {
      const matches = await worker.evaluate((expectedName) =>
        chrome.runtime?.getManifest?.().name === expectedName, manifest.name).catch(() => false);
      if (matches) return worker;
    }
    throw new Error(`No service worker belongs to ${manifest.name}`);
  }, `Playwright did not discover the ${manifest.name} service worker`, { timeout: 15_000 });
}

async function getActiveTab(serviceWorker) {
  return serviceWorker.evaluate(() => new Promise((resolveTab, rejectTab) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
      const [tab] = tabs;
      if (!tab) return rejectTab(new Error('Chrome has no active tab in its last focused window'));
      resolveTab({ id: tab.id, windowId: tab.windowId });
    });
  }));
}

async function createTab(serviceWorker, { url, windowId, active }) {
  return serviceWorker.evaluate((properties) => new Promise((resolveTab, rejectTab) => {
    chrome.tabs.create(properties, (tab) => {
      if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
      resolveTab({ id: tab.id, windowId: tab.windowId });
    });
  }), { url, windowId, active });
}

async function activateTab(serviceWorker, tab) {
  await serviceWorker.evaluate(({ id, windowId }) => new Promise((resolveTab, rejectTab) => {
    chrome.windows.update(windowId, { focused: true }, () => {
      if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
      chrome.tabs.update(id, { active: true }, () => {
        if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
        chrome.tabs.query({ active: true, windowId }, (tabs) => {
          if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
          if (tabs[0]?.id !== id) return rejectTab(new Error(`Chrome kept tab ${tabs[0]?.id} active instead of ${id}`));
          resolveTab();
        });
      });
    });
  }), tab);
}

async function getPage(context, url) {
  return poll(async () => {
    const page = context.pages().find((candidate) => candidate.url() === url);
    assert.ok(page, `Playwright has not attached to ${url}`);
    return page;
  }, `Playwright did not discover the Chrome tab for ${url}`);
}

async function getPipCounts(page) {
  return page.evaluate(() => ({
    enter: Number(document.querySelector('#pip-enter-count').textContent),
    leave: Number(document.querySelector('#pip-leave-count').textContent)
  }));
}

test('Playwright verifies stored settings and tab-switch PiP behavior', { timeout: 90_000 }, async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'auto-pip-playwright-'));
  const fixture = await startFixtureServer();
  const { browser, context, child } = await launchChromium(userDataDir);

  try {
    const versionPage = await context.newPage();
    await versionPage.goto('chrome://version');
    const commandLine = await versionPage.locator('#command_line').textContent();
    if (process.env.PLAYWRIGHT_HEADLESS !== '1') {
      assert.ok(!commandLine.includes('--headless'), 'headed E2E unexpectedly launched a headless browser');
    }
    await versionPage.close();

    const serviceWorker = await getExtensionServiceWorker(context);
    const extensionId = new URL(serviceWorker.url()).host;
    assert.match(extensionId, /^[a-p]{32}$/, 'Playwright did not load the unpacked extension');

    const initialTab = await getActiveTab(serviceWorker);
    const videoUrl = `${fixture.origin}/video.html`;
    const videoTab = await createTab(serviceWorker, {
      url: videoUrl, windowId: initialTab.windowId, active: true
    });
    const videoPage = await getPage(context, videoUrl);
    await videoPage.waitForLoadState('domcontentloaded');
    await videoPage.locator('#start').waitFor();

    const otherUrl = `${fixture.origin}/other.html`;
    const otherTab = await createTab(serviceWorker, {
      url: otherUrl, windowId: videoTab.windowId, active: false
    });
    const otherPage = await getPage(context, otherUrl);
    await otherPage.waitForLoadState('domcontentloaded');

    assert.equal(await getSetting(serviceWorker, 'enabled'), true,
      'extension should be enabled by default');
    await setSetting(serviceWorker, 'enabled', false);
    await poll(async () => assert.equal(await getSetting(serviceWorker, 'enabled'), false),
      'extension did not persist the disabled setting to chrome.storage.sync');

    await activateTab(serviceWorker, videoTab);
    await videoPage.locator('#start').click();
    await videoPage.locator('#ready[data-playing="true"]').waitFor();
    await activateTab(serviceWorker, otherTab);
    await poll(async () => assert.equal(
      await videoPage.evaluate(() => document.visibilityState), 'hidden'),
    'Playwright did not move the video page into the background');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    assert.deepEqual(await getPipCounts(videoPage), { enter: 0, leave: 0 },
      'disabled extension unexpectedly changed picture-in-picture state');

    await setSetting(serviceWorker, 'enabled', true);
    await poll(async () => assert.equal(await getSetting(serviceWorker, 'enabled'), true),
      'extension did not persist the enabled setting to chrome.storage.sync');

    await activateTab(serviceWorker, videoTab);
    await videoPage.locator('#start').click();
    await activateTab(serviceWorker, otherTab);
    await poll(async () => {
      const counts = await getPipCounts(videoPage);
      assert.ok(counts.enter >= 1, `expected at least one PiP entry, got ${counts.enter}`);
    }, 'switching away from a playing video did not enter picture-in-picture');

    await activateTab(serviceWorker, videoTab);
    await poll(async () => {
      const counts = await getPipCounts(videoPage);
      assert.ok(counts.leave >= 1, `expected at least one PiP exit, got ${counts.leave}`);
    }, 'returning to the video tab did not exit picture-in-picture');
  } finally {
    await browser.close().catch(() => {});
    if (child.exitCode == null) child.kill('SIGTERM');
    await fixture.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

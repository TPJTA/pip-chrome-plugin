/**
 * 真实端到端验证：file:// 页面 + 真实媒体文件 + 一次真实点击，验证
 * 「切走标签页 → 自动进入画中画 → 切回来自动退出」这条链路在**没有**站点动作
 * 处理器时也能反复成立，并且确由扩展桥接脚本注册的 dispatcher 承载。
 *
 * 为什么必须是 file://：浏览器源码里 IsEligibleForAutoPictureInPicture() 明确要求
 * URL 是 https:// 或 file://，http://127.0.0.1 在资格检查第一道门就被拒，永远
 * 不可能触发自动画中画。所以这里不能用本地 HTTP 服务器，改用临时目录里的
 * file:// fixture。
 *
 * 证据分层（这一层区分是刻意的）：
 *   1. 无论是否进入窗口模式，都必须成立的是**行为**：切走时视频进入画中画，
 *      切回时退出，连续多轮；
 *   2. 进入路径必须由 MAIN world 桥接脚本注册的 dispatcher 承载（面板状态里
 *      的 nativeAutoPip），而不是「浏览器自己开窗」那条我们看不到的路径；
 *   3. 「允许网站自动画中画」是 Chrome 首次触发时弹提示才给的站点授权，自动化
 *      里拿不到，所以第 1 条允许两种真实可行的来源：浏览器自动画中画真的开窗，
 *      或扩展用请求时刻的短暂用户激活开窗。两者都要求真实用户激活，都不是伪造的。
 *      只有二者都不成立才算失败。
 *
 * ⚠️ 刻意不断言的两件事：`details.reason`（Chrome 153 根本不向页面回调传这个字段），
 * 以及 `auto-pip:enter` 事件计数（浏览器自带自动画中画路径不派发 media session 动作）。
 * 把这两者写成断言只会制造假证据。
 *
 * 采样一律走 CDP Runtime.evaluate{userGesture:false}，避免用 Playwright 的
 * click/evaluate 顺势给出用户激活，从而不把「采样动作本身造的激活」当成产品信号。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
const manifest = JSON.parse(await readFile(join(projectRoot, 'manifest.json'), 'utf8'));

const ROUNDS = Number(process.env.E2E_ROUNDS || 3);
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

async function poll(assertion, message, { timeout = 15_000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await sleep(interval);
    }
  }
  throw new Error(message, { cause: lastError });
}

async function launchChromium(userDataDir) {
  const child = spawn(chromium.executablePath(), [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1000,760',
    `--disable-extensions-except=${projectRoot}`,
    `--load-extension=${projectRoot}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });

  // 用 DevToolsActivePort 拿真实端口，避免固定端口和别的实例撞车。
  const endpoint = await poll(async () => {
    if (child.exitCode != null) throw new Error(`Chromium exited with ${child.exitCode}: ${stderr}`);
    const [port] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    assert.match(port, /^\d+$/);
    return `http://127.0.0.1:${port}`;
  }, 'Chromium did not expose a DevTools endpoint', { timeout: 20_000 });
  const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });

  const context = browser.contexts()[0];
  assert.ok(context, 'Playwright did not discover the Chromium default context');
  return { browser, context, child };
}

async function getExtensionServiceWorker(context) {
  return poll(async () => {
    for (const worker of context.serviceWorkers()) {
      const matches = await worker.evaluate((expectedName) =>
        chrome.runtime?.getManifest?.().name === expectedName, manifest.name).catch(() => false);
      if (matches) return worker;
    }
    throw new Error(`No service worker belongs to ${manifest.name}`);
  }, `Playwright did not discover the ${manifest.name} service worker`, { timeout: 20_000 });
}

/**
 * 用扩展自己的 chrome.tabs.create 开标签页，并拿回它返回的 id。
 *
 * 不靠 chrome.tabs.query 反查：这个扩展只申请了 storage 权限、没有 tabs 权限，
 * tab.url / tab.title 永远是 undefined，而「新出现的 id」这种差集写法又会和
 * 浏览器自己的 target 时序打架（探针里同一步骤时而成立时而不成立）。
 * tabs.create 的回调参数是权威答案，不依赖任何查询。
 */
async function createTab(serviceWorker, { url, windowId, active }) {
  return serviceWorker.evaluate((properties) => new Promise((resolveTab, rejectTab) => {
    chrome.tabs.create(properties, (tab) => {
      if (chrome.runtime.lastError) return rejectTab(new Error(chrome.runtime.lastError.message));
      resolveTab({ id: tab.id, windowId: tab.windowId, active: tab.active });
    });
  }), { url, windowId, active });
}

/** 按 URL 找到 Playwright 已经 attach 上的那个 Page。 */
async function getPage(context, url) {
  return poll(async () => {
    const page = context.pages().find((candidate) => candidate.url() === url);
    assert.ok(page, `Playwright has not attached to ${url}: ${JSON.stringify(context.pages().map((p) => p.url()))}`);
    return page;
  }, `Playwright did not discover the Chrome tab for ${url}`);
}

/** 当前的工作窗口 id：新标签页必须开在同一个窗口里，切换才有意义。 */
async function getWindowId(serviceWorker) {
  return serviceWorker.evaluate(() => new Promise((resolveWindow, rejectWindow) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return rejectWindow(new Error(chrome.runtime.lastError.message));
      if (!tabs[0]) return rejectWindow(new Error('Chrome has no active tab in its last focused window'));
      resolveWindow(tabs[0].windowId);
    });
  }));
}

test('native auto-PiP drives the bridge dispatcher across repeated tab switches',
  { timeout: 180_000 }, async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'auto-pip-native-e2e-'));
    const fixtureDir = await mkdtemp(join(tmpdir(), 'auto-pip-native-fixture-'));
    const sitePath = join(fixtureDir, 'video.html');
    const otherPath = join(fixtureDir, 'other.html');
    await writeFile(sitePath, await readFile(join(here, 'fixtures', 'native-video.html')));
    await writeFile(otherPath, await readFile(join(here, 'fixtures', 'other.html')));
    const siteUrl = `file://${sitePath}`;
    const otherUrl = `file://${otherPath}`;

    const { browser, context, child } = await launchChromium(userDataDir);

    try {
      const serviceWorker = await getExtensionServiceWorker(context);
      const extensionId = new URL(serviceWorker.url()).host;
      assert.match(extensionId, /^[a-p]{32}$/, 'the unpacked extension did not load');

     // Chrome 启动时只有一个窗口、一个标签页，而 Playwright 的 context.pages()[0]
      // 拿到的就是它，直接 goto 只会复用它。两个 fixture 都改成用扩展自己的
      // chrome.tabs.create 新建，回调里的 id 是权威答案，不需要任何反查。
      const existingPages = context.pages();
      for (const extra of existingPages.slice(1)) await extra.close().catch(() => {});
      const windowId = await getWindowId(serviceWorker);
      const startTab = existingPages[0];

      const openFixture = async (url) => {
        const tab = await createTab(serviceWorker, { url, windowId, active: true });
        const page = await getPage(context, url);
        await page.waitForLoadState('domcontentloaded');
        return { tab, page };
      };

      const site = await openFixture(siteUrl);
      const other = await openFixture(otherUrl);
      const siteTab = site.tab;
      const otherTab = other.tab;
      const page = site.page;
      assert.equal(siteTab.windowId, windowId, 'the video tab opened in an unexpected window');
      assert.equal(otherTab.windowId, windowId, 'the other tab opened in an unexpected window');
      assert.notEqual(otherTab.id, siteTab.id, 'the two fixtures collapsed into one tab');

      // 启动时那个标签页用不上了，关掉它，免得它成为「另一个窗口里的活跃页」干扰判定。
      await startTab.close().catch(() => {});

      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(String(error)));
      await page.bringToFront();

      // 采样只走 CDP，且显式关掉 userGesture：Playwright 的 evaluate/click
      // 会顺势给出用户激活，那样就无法区分「浏览器自动画中画」和「我们自己造的激活」。
      const session = await context.newCDPSession(page);
      const evaluate = async (expression) => {
        const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true, userGesture: false
        });
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
        return result.value;
      };
      const snapshot = async () => JSON.parse(await evaluate('JSON.stringify(window.__snapshot())'));

      // 等页面脚本就绪。
      await poll(async () => {
        const state = await evaluate(`JSON.stringify(
          document.querySelectorAll('video').length > 0
        )`);
        assert.equal(state, 'true');
      }, 'the fixture page never became ready');

      // 唯一一次真实点击：录一段带音轨的真实媒体文件再循环播放。
      await page.locator('#play').click();
      await poll(async () => {
        const ready = await evaluate('JSON.stringify(document.body.dataset.playing === "true")');
        assert.equal(ready, 'true', 'fixture media did not start');
      }, 'the fixture never started playing', { timeout: 30_000 });
      await sleep(1200);

      const media = JSON.parse(await evaluate(`JSON.stringify({
        muted: document.querySelector('#v').muted,
        paused: document.querySelector('#v').paused,
        readyState: document.querySelector('#v').readyState,
        audioDecodedBytes: document.querySelector('#v').webkitAudioDecodedByteCount
      })`));
      // 没有音轨就拿不到自动画中画资格，这条断言把「fixture 录废了」和
      // 「扩展有问题」区分开。
      assert.ok(media.audioDecodedBytes > 0, `fixture media has no audio track: ${JSON.stringify(media)}`);
      assert.equal(media.muted, false);

      // 面板报的是 isolated world 里真实记录的注册状态：只有浏览器侧确实由我们的
      // dispatcher 顶着，才可能出现下面那种「页面没有处理器仍然进得来」的结果。
      const report = await poll(async () => {
        const status = await serviceWorker.evaluate((tabId) => new Promise((resolveSend) => {
          chrome.tabs.sendMessage(tabId, { type: 'pip:status' }, (reply) => {
            if (chrome.runtime.lastError) return resolveSend({ error: chrome.runtime.lastError.message });
            resolveSend(reply ?? null);
          });
        }), siteTab.id);
        assert.ok(status && !status.error, `pip:status failed: ${JSON.stringify(status)}`);
        assert.equal(status.nativeAutoPip.dispatcher, true, 'the bridge holds no dispatcher');
        assert.equal(status.nativeAutoPip.siteHandler, false, 'the fixture registered a site handler');
        assert.equal(status.nativeAutoPip.allowed, true, 'the bridge is not in its allowed state');
        return status;
      }, 'the MAIN-world bridge never took over the media session');

      /** 进入路径只能是这两条之一，两者都建立在真实用户激活上。 */
      const ENTRY_ORIGINS = {
        'native-auto-pip': 'Chrome 自己的自动画中画开窗',
        'extension-request': '扩展在请求时刻用真实用户激活开窗'
      };

      const rounds = [];
      for (let round = 1; round <= ROUNDS; round++) {
        await page.bringToFront();
        await poll(async () => {
          const ready = await snapshot();
          assert.equal(ready.pip, 'none',
            `round ${round}: 返回后画中画没有退出 / PiP still open: ${JSON.stringify(ready)}`);
          assert.equal(ready.visibility, 'visible',
            `round ${round}: 视频标签页没有回到前台 / video tab is not in the foreground: ${JSON.stringify(ready)}`);
        }, `round ${round}: returning to the video tab left it in a bad state`);

        // 循环播放会在窗口模式里继续跑；只要还在播，下一轮就仍有触发资格。
        const before = await snapshot();
        assert.equal(before.enterEvents, round - 1,
          `round ${round}: 起点就带着不该有的进入事件 / unexpected PiP entries before this round: ${JSON.stringify(before)}`);

        await other.page.bringToFront();
        await poll(async () => {
          const away = await snapshot();
          assert.equal(away.visibility, 'hidden',
            `round ${round}: 视频标签页没有切到后台 / the video tab stayed foreground: ${JSON.stringify(away)}`);
          assert.equal(away.pip, 'video',
            `round ${round}: 切走后没有进入画中画 / switching away did not open PiP: ${JSON.stringify(away)}`);
        }, `round ${round}: switching away never opened PiP`, { timeout: 25_000 });

        const away = await snapshot();
        const origin = away.enterEvents >= round ? 'native-auto-pip'
          : away.nativeCallbacks >= round ? 'extension-request'
          : null;
        assert.ok(origin !== null,
          `round ${round}: 进了画中画，但既不是 Chrome 自动画中画，也不是扩展处理器在真实激活下开窗 / `
          + `PiP opened with no accountable trigger: ${JSON.stringify(away)}`);
        assert.ok(ENTRY_ORIGINS[origin]);

        // 回归保证：进入时必须走我们的 dispatcher。站点在这轮之前从未注册过处理器，
        // 所以这里一旦变 false，说明桥接被挤掉了。
        const during = await serviceWorker.evaluate((tabId) => new Promise((resolveSend) => {
          chrome.tabs.sendMessage(tabId, { type: 'pip:status' }, (reply) => {
            if (chrome.runtime.lastError) return resolveSend({ error: chrome.runtime.lastError.message });
            resolveSend(reply ?? null);
          });
        }), siteTab.id);
        assert.ok(during && !during.error && during.nativeAutoPip.dispatcher === true,
          `round ${round}: 进入期间桥接没有持有 dispatcher / the bridge lost the dispatcher: ${JSON.stringify({ during, away })}`);

        await page.bringToFront();
        await poll(async () => {
          const back = await snapshot();
          assert.equal(back.pip, 'none',
            `round ${round}: 返回后没有退出画中画 / returning did not exit PiP: ${JSON.stringify(back)}`);
        }, `round ${round}: returning never exited PiP`, { timeout: 25_000 });

        const back = await snapshot();
        // 退出事件计数可能超前于 DOM 派发（CDP 采样不带用户激活，不会补派发），
        // 所以只要求「至少退过一次」，不要求它和本轮号严格相等。
        assert.ok(back.leaveEvents >= round,
          `round ${round}: 浏览器没有记录到退出画中画 / the browser never reported leaving PiP: ${JSON.stringify(back)}`);
        assert.equal(back.visibility, 'visible',
          `round ${round}: 返回后视频标签页没有回到前台 / the video tab did not come back: ${JSON.stringify(back)}`);

        rounds.push({ round, origin, away, back });
      }

      assert.equal(rounds.length, ROUNDS);

      // 站点在本扩展之后注册处理器时，桥接层必须把派发权完整交还，而且不能反过来
      // 把网站刚注册的处理器清掉。这里就在页面世界（普通页面脚本）里注册，不需要
      // 任何额外扩展权限。
      await evaluate(`JSON.stringify((() => {
        window.__siteHandlerCalls = 0;
        navigator.mediaSession.setActionHandler('enterpictureinpicture', () => {
          window.__siteHandlerCalls++;
        });
        return true;
      })())`);

      const handedOver = await serviceWorker.evaluate((tabId) => new Promise((resolveSend) => {
        chrome.tabs.sendMessage(tabId, { type: 'pip:status' }, (reply) => resolveSend(reply ?? null));
      }), siteTab.id);
      assert.equal(handedOver.nativeAutoPip.siteHandler, true,
        'the bridge never noticed the site handler that arrived after it');
      assert.equal(handedOver.nativeAutoPip.dispatcher, false,
        'the bridge kept its own dispatcher after the site took over');

      // 包装必须还在（否则网站之后再改处理器就没人观察了），而网站那次注册必须
      // 原样生效 —— 这才是「没被清掉」的可观察形式：动作交给网站，它自己开窗。
      const held = await evaluate(`JSON.stringify(
        MediaSession.prototype.setActionHandler.name === 'wrappedSetActionHandler'
      )`);
      assert.equal(held, 'true', 'the bridge wrapper disappeared during the handover');

      await other.page.bringToFront();
      await poll(async () => {
        const away = await snapshot();
        assert.equal(away.pip, 'video', 'the site handler did not receive the automatic entry');
      }, 'the site handler never received the automatic entry', { timeout: 20_000 });
      assert.ok(Number(await evaluate('JSON.stringify(window.__siteHandlerCalls)')) > 0,
        'the browser called us instead of the site handler');

      await page.bringToFront();
      await poll(async () => {
        const back = await snapshot();
        assert.equal(back.pip, 'none', 'the site handler never exited picture-in-picture');
      }, 'returning to the tab did not exit PiP with a site handler in place', { timeout: 20_000 });

      // 网站放手之后，桥接层重新顶上。
      await evaluate(`JSON.stringify((() => {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
        return true;
      })())`);
      const reclaimed = await serviceWorker.evaluate((tabId) => new Promise((resolveSend) => {
        chrome.tabs.sendMessage(tabId, { type: 'pip:status' }, (reply) => resolveSend(reply ?? null));
      }), siteTab.id);
      assert.equal(reclaimed.nativeAutoPip.siteHandler, false,
        'the bridge did not release the site handler it was tracking');
      assert.equal(reclaimed.nativeAutoPip.dispatcher, true,
        'the bridge did not take the media session back after the site let go');

      assert.deepEqual(pageErrors, [],
        `fixture 页面报了脚本错误 / the fixture page reported script errors: ${JSON.stringify({ pageErrors, rounds: rounds.map((r) => r.round) })}`);
   } finally {
     await browser.close().catch(() => {});
     if (child.exitCode == null) child.kill('SIGTERM');
      // 浏览器仍在收尾时配置文件目录可能还在写，force 也压不住 ENOTEMPTY；
      // 临时目录留着无害，清理失败不该把测试结果改成失败。
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
      await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
   }
  });

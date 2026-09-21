# 画中画退出机制 · 实验台账（Pip Debug Log）

> **强制规则**：任何新测试之前，必须先在 §1.2「已排除原因」和 §1.4「禁止重复的实验」里查一遍。
> 与既有条目等价的实验禁止重跑；确有必要重跑时，必须在条目中写明「与既有实验的差异」。
> 禁止在此记录任何敏感信息或临时 profile 内容。

> **冲突处理规则（本文件的核心约定）**：本台账按时间顺序记录，早期结论一律不得当作最终事实。
> 凡是被后续实验证伪或修正的条目，都在条目顶部用 **`[后续证伪]`** 或 **`[后续修正]`** 标记，
> 并同时保留**双方的原始环境、原始证据与原始结论**，不做删改。当前有效结论以 §1.1 / §1.2 为准。

---

## 0. 环境基线（固定变量）

| 项 | 值 |
| --- | --- |
| 系统 Chrome | Google Chrome 153.0.8010.48 |
| 测试用 Chrome | Chrome for Testing 153.0.8010.12（Playwright chromium-1243） |
| Playwright | 1.63.0 |
| 平台 | macOS arm64 |
| 扩展 | 未打包加载，manifest v3，id `glplboifahbbglkmliclgicfjibndlld`（工作区 v1.1.0） |
| 采样方式 | CDP `Runtime.evaluate{userGesture:false, awaitPromise:true}` + Service Worker `chrome.runtime.sendMessage({type:'pip:status'})` |
| 站点 fixture | `tests/e2e/fixtures/native-video.html`；早期诊断另有 `/private/tmp/pip-probe/native/file-video.html` |
| 打开方式 | 早期：会话内手工切标签 / Playwright `newPage()+goto`；后期：扩展 `chrome.tabs.create` + `context.pages().find(p=>p.url()===url)` |

> **临时文件声明**：仓库根目录下的 `.probe-*.mjs`（共 19 个：`tabs / c / c2 / c3 / exit / exit2–exit13 / split / bisect`）全部是**未纳入版本控制的临时探针文件**，不属于交付内容。最终交付前应整体移动到 `/private/tmp` 或直接删除；**在此之前不要删除**，因为本台账中的证据路径仍指向它们。

---

## 1. 首页四表

### 1.1 已确认事实（F）

| 编号 | 事实 | 证据（含原始环境） | 状态 |
| --- | --- | --- | --- |
| F1 | **隐藏**状态下 `document.exitPictureInPicture()` 可靠完成：promise resolve，pip→none，并派发真实 `leavepictureinpicture` | E6/E12；file:// 与 http 两种 fixture 一致 | 有效 |
| F2 | **可见**状态下同一调用永久挂起（10s 后 `resolvedAt:null`） | implement 探针：`.probe-exit4.mjs`、`.probe-exit5.mjs`（日志 `/tmp/diag/exit-request.log`、`exit-disable.log`） | 有效 |
| F3 | `disablePictureInPicture=true` 在可见态无效，但在**隐藏**期间设置可生效 | `/tmp/diag/exit-disable.log`：隐藏期间设置 → `leaveEvents:1`、pip→none | 有效 |
| F4 | **完全不加载扩展**时，返回页面后 Chrome 原生自动 PiP 自行关闭，3/3 | E7 case0、E13；file:// fixture；无扩展 | 有效 |
| F5 | **只加载 bridge**（`native-pip-bridge.js`，MAIN world，无 content.js）时 Chrome 仍自行关闭，3/3。**边界限定（E19/E20 收紧）**：该组运行在 `allowed:false`、dispatcher 未注册态，Chrome 走 browser-initiated 分支；E20 证明 dispatcher 已注册且进入确实发生时**同样**自动关闭，故 F5 不可用于支持「dispatcher 参与可抑制关闭」 | implement 探针 `.probe-split.mjs` case1，输出 `/tmp/split.txt` 第 1 组；收紧依据 E19 `/tmp/E19.txt`、E20 `/tmp/E20.txt` | 有效（附边界） |
| F6 | **只加载 content.js**（无 bridge）时 Chrome **不**自行关闭，3/3；`leaveEvents:0`，`exitCalls:0` | implement 探针 `.probe-split.mjs` case2，输出 `/tmp/split.txt` 第 2 组 | 有效 |
| F6·附注 | **经 E22 纠正**：F6 的「不关闭」**不是** `content.js` 主动抑制浏览器关闭。直接机制是**返回（可见态）时那次 `document.exitPictureInPicture()` 调用永久挂起（`settle:"pending"`）**：未结算的 promise 长期占用 `exiting`，同时 `cancelAutomaticEntry()` 已把 `autoSuppressed` 置 `true` —— 二者叠加使页面既不重试退出、也不再允许自动进入，Chrome 的自动 leave 也不再发生。触发条件是「返回时 `document.pictureInPictureElement` 非空且 `settings.exitOnReturn` 为真」。**F6 原始观测（3/3 不关闭、`exitCalls:0`）仍有效**，被纠正的只是因果归因。 | E22 `/tmp/E22.txt`；对照 F14 | 有效（附注为再归因） |
| F7 | 完整扩展 / 完整扩展 + exit 计数器，均不自行关闭，`exitCalls:0` | E7 case3、case4 | 有效 |
| F8 | 进入 PiP 的**可靠信号**只有两个：`document.pictureInPictureElement` 非空，以及页面收到 `enterpictureinpicture` 事件。此前使用的 `nativeCallbacks` / `dispatcherCalls` 属于探针对内部回调的计数，**不能作为「进入来源」的证据**，已废弃 | E7、E9、E10、E13 的 `pip` 字段与 `enterEvents` | 有效（已改写） |
| F9 | 返回时先触发 `visibilitychange → visible`，`tabs.onActivated` 约 **3546ms** 之后才到；此前没有更早的隐藏信号 | E10/E11 采样 | 有效 |
| F10 | `tabs.onActivated` 返回时确实触发；`pip:tabActivated` 在隐藏态送达能退出，可见态送达不能退出 | E9/E10 | 有效 |
| F11 | E2E 必须用扩展 `chrome.tabs.create` 打开 fixture，再用 `context.pages().find(p=>p.url()===url)` 取页面 | 多次踩坑 | 有效 |
| F12 | `npm test` 42/42 通过 | 已运行 | 有效 |
| F13 | `chrome.tabs.create` 打开的 http://127.0.0.1 fixture，即使加载完整扩展，也自动关闭 3/3（对照 file:// fixture 加载完整扩展时不关闭） | repair_pip 报告；**原日志路径待补（D1）** | **待复核（H6）** |
| F14 | **受限表述（仅限本轮受控环境：Chrome for Testing 153.0.8010.12 + E22/F2 条件，即返回时 `document.pictureInPictureElement` 非空且 `settings.exitOnReturn` 为真）**：可见态发起的 `document.exitPictureInPicture()` 其 promise **一直处于 `pending`**（至脚本结束未 settle，无 resolve / 无 reject），且此后**未观测到浏览器自动 leave**。**不得**表述为普适定律：仅在上述环境与条件下观测到，「是否所有 Chrome 版本 / 所有返回时序都如此」未验证。 | E22 `/tmp/E22.txt`；F2 为独立佐证 | 有效（附环境限制） |

> **F6 是当前最关键发现**：抑制 Chrome 原生自动关闭的是 `content.js` **本身**，且不是它那次 exit 调用造成的（`exitCalls:0`）。
>
> **经 E22 纠正（保留上文原文）**：「抑制者」不是 `content.js` 的主动屏蔽逻辑，而是**可见态那次 `document.exitPictureInPicture()` 调用挂起后未结算的 promise**。F6 早期记录 `exitCalls:0` 与 E22 的 `realExitCalls:1` 口径不同：前者数的是「完整扩展运行期间的累计调用」，E22 证明在**同一条件**下该调用确实会发生一次（发生在返回时）且**不 settle**。因此以「exit 调用是否成功」为判据的口径会得出误导结论；判据应改为「是否在可见态发起该调用」。
>
> **F14（受限表述）** 是本条的直接证据。修复方向（`lastEntryOrigin` 区分进入来源，native-auto 路径不再显式退出）已由 **E23 3/3 验证通过**。

### 1.2 已排除原因（X）

| 编号 | 被排除的判断 | 依据 | 状态 |
| --- | --- | --- | --- |
| X1 | 「bridge 没被注入」 | F5（只加载 bridge 仍自动关闭）；`bridge-presence.log` 显示 MAIN world 中 `setActionHandler.name === 'wrappedSetActionHandler'` | 有效 |
| X2 | 「`details.reason` 可用」——Chrome 153 不传递该字段，站内 handler 收到的始终是 `reason=none` | `/tmp/diag/site-reason.log`、`late-*.log` | 有效 |
| X3 | 「注册时机（dcl / play）会改变 `reason`」 | `late-dcl.log` vs `late-play.log`：`dcl:none` / `play:none`，无差异 | 有效 |
| X4 | 「pause + play 会导致退出」 | `/tmp/diag/exit-pause.log`：`leaveEvents:0`，返回后 pip 仍为 video | 有效 |
| X5 | 「mediaSession 的 `exitpictureinpicture` action 可被浏览器推送」 | `/tmp/diag/exit-action.log`：非法枚举值，注册即 TypeError；`exitActionCalls:0` | 有效 |
| X6 | 「可见态改用 `disablePictureInPicture` 可行」 | F2 + F3 | 有效 |
| X7 | 「扩展的 `tabs.onActivated` / `bringToFront` 时序就是自动关闭的原因」 | **已撤回**：无扩展（F4）与只加载 bridge（F5）时照样自动关闭，而它们都没有该逻辑；且与 E11 的 `dispatcherCalls:0` 矛盾 | **已撤回** |
| X8 | 「content.js 是通过调用 exit 关闭 PiP 的」 | F6/F7：`exitCalls:0` 且 `leaveEvents:0`，PiP 一直保持 | 有效 |
| X9 | `[后续修正]` 「file:// 不行 / 换 http 就能复现」 | **被后续实验证伪**：file:// 下无扩展（E13）与只加载 bridge（E7 case1）都能自动关闭；http 并非稳定可进入的环境（X11） | **已证伪** |
| X10 | `[后续修正]` 「把 handler 搬到 MAIN world / 用扩展 dispatcher 能解决」 | `bridge-presence.log` 证明 dispatcher 在场，但仍不自动关闭（F7） | **已证伪** |
| X11 | 「`http://127.0.0.1` 可作为自动 PiP 的复现环境」 | **被源码与实测双重排除**：Chromium 自动 PiP 的资格门槛对 scheme 有硬性限制，实测中 http 并非稳定可进入的环境 | 有效 |
| X12 | 「E19 的 `entered:false` 说明 dispatcher 未派发或 Chrome 走了 manual 分支」 | **已排除（E20）**：同配置下加一个页面侧 `auto-pip:enter` 监听后，3/3 回调到达、`requestPictureInPicture()` 3/3 成功、away 时 `pip:video`。E19 的 `entered:false` 仅因页面侧无人处理该事件 | 有效 |

### 1.3 尚未验证的假设（H）

| 编号 | 假设 | 当前状态 |
| --- | --- | --- |
| H1 | content.js 在隐藏期间发送 `pageHidden` 消息是抑制源 | **已证伪并复现**（E16 / E8 group B，3/3 自动关闭，日志 `/tmp/bisect-B.txt`） |
| H2 | content.js 的 `onMessage` handler 注册（`pip:tabActivated` / `pip:status` / `pip:toggle`）是抑制源 | **已证伪并复现**（E17 / E8 group D，3/3 自动关闭，日志 `/tmp/bisect-D.txt`） |
| H3 | 分片版 content.js 与真实 content.js 存在无关差异，导致 E8 结论外推性有限 | 未验证（D4） |
| H4 | 700ms 等待窗口与旧 fallback 竞争 | 未验证 |
| H5 | `chrome.windows` 可拿到早于 `tabs.onActivated` 的信号（需新权限） | 未验证，暂缓 |
| H6 | `chrome.tabs.create` + http 与 Playwright `newPage()` + file 之间存在某个环境差异，会让自动关闭行为反转 | **未验证，是当前最大未记账变量** |
| H7 | B（`pageHidden` 消息）与 D（镜像 `onMessage` handlers）**组合**后产生交互效应，成为抑制源 | **已证伪并复现**（E18 / E8 group C，3/3 自动关闭，日志 `/tmp/bisect-C.txt`） |
| H8 | E7 case1 的「自动关闭」发生在 dispatcher 未注册态；一旦真正注册 dispatcher 并 `allowed:true`，自动关闭就不再发生 | **已证伪**（E20）：dispatcher 已注册且 `allowed:true`、且进入确实发生的条件下，返回时仍 3/3 自动关闭 |
| H9 | dispatcher 已注册且 `allowed:true` 时，`auto-pip:enter` 是否真的被派发；页面侧对该事件调用 `requestPictureInPicture()` 能否重新进入 PiP | **已验证成立**（E20）：3/3 回调到达，`requestPictureInPicture()` 3/3 `{ok:true}`，away 时 `pip:video` |
| H10 | content.js `visibilitychange` 的 **hidden 分支主体**（`pickVideo()` / dispatcher+allowed 时 700ms 等待 / `askServiceWorker(pageHidden)` / fallback `enterPictureInPicture({automatic:true})`）是抑制自动关闭的源头 | **已证伪**（E21）：hidden 分支确实执行（`pageHidden` 1/2/3），返回仍 3/3 自动关闭，`realExitCalls:0` |
| H11 | 在 E21 条件下把 visible 分支恢复为真实 content.js 同形的 `exitPictureInPicture()` 后，返回时的「自动关闭」其实由这次 exit 调用完成（而非浏览器自行关闭） | **已证伪**（E22）：`exitCalls` 仅 1 次且 `settle:"pending"`，`leaveEvents:0`，3 轮 backPip 均为 `video`（PiP 未关闭） |
| H12 | E22 观测到的「可见态 exit 调用挂起（`pending`）」与 F2 的「可见态 `document.exitPictureInPicture()` 永久挂起」是同一现象（而非本轮时序偶然） | 未验证 |
| H13 | 完成最小产品修复（进入来源区分 + native-auto 路径不在可见态显式退出 + 离开后复位状态 + 移除 `tabs.onActivated` 主动退出）后，真实扩展每轮都能进入、由浏览器关闭、全程无可见态显式退出、且下一轮仍能进入 | **已验证成立**（E23）：3/3 轮 `away.pip:video`、`back.pip:none`、leaveEvents 1/2/3 递增、`visibleExitCalls:0`、exitCalls 全程为空 |
| H14 | 完成最小修复并改写单元测试后，`npm test` 全绿 | **已验证成立**（E24）：44/44 通过、0 失败、0 跳过 |
| H15 | 修复后 `npm run test:e2e:native` 全绿 | **已证伪**（E25）：常规 3 轮循环通过，但站点处理器交还段失败（`the site handler never exited picture-in-picture`）；诊断显示扩展 fallback 开的窗口在可见态退出同样挂起（F14 第二处复现） |

### 1.4 禁止重复的实验（N）

| 编号 | 禁止重跑 | 原因 |
| --- | --- | --- |
| N1 | 「不加载扩展」基线 | F4 已 3/3 确认；且自动 PiP 的 scheme 门槛已由源码与实测确认（X11），重跑无信息增益 |
| N2 | 「只加载 bridge」基线 | F5 已 3/3 确认 |
| N3 | 可见态下尝试 `document.exitPictureInPicture()` | F2 已确认必然挂起 |
| N4 | pause/play、可见态 `disablePictureInPicture`、mediaSession `exitpictureinpicture` action 三种退出手段 | X4/X5/X6 已排除 |
| N5 | 在 `dcl` / `play` 两个时机重测 `details.reason` | X2/X3 已排除 |
| N6 | 「只加载 content.js」的自动关闭对照 | F6 已 3/3 确认；**该组是关键对照组，除非写明变量差异，不得重跑** |
| N7 | 用 http 重跑「无扩展基线」来反证 F6 | X9 已证伪该思路 |
| N8 | E8 group B（空 visibility + `pageHidden` 消息） | E16 已 3/3 复现，H1 已证伪，重跑无信息增益 |
| N9 | E8 group D（空 visibility + `onMessage` 状态处理器） | E17 已 3/3 复现，H2 已证伪，重跑无信息增益 |
| N10 | E8 group C（B+D 组合） | E18 已 3/3 复现，H7 已证伪，重跑无信息增益 |
| N11 | 会话内手工切标签的 file:// 对照（E13/E14 组合） | 已有证据；若要重跑，必须改写为与 E15 同协议、同打开方式，并在条目中说明差异 |
| N12 | 把「原样加载真实扩展的三轮验证」当作常规回归反复重跑 | **E23 已 3/3 通过**；该验证的对象是**修复候选**，只在产品修复代码变更时重跑，不用于重复确认已稳定的结论 |

---

## 2. 实验条目（按时间顺序）

### E1–E3 · 17:00–17:40 — 入口来源与采样链路
- **待验证假设**：进入 PiP 的来源有哪些。
- **配置**：file:// fixture + 完整扩展。
- **实际观测**：`enterEvents++`（原生自动 PiP）与 `nativeCallbacks++`（扩展请求）两条独立路径。
- **结论**：F8。日志 `/tmp/diag/`。

### E4 · 18:26 `exit-request` — 可见态退出手段

> 脚本：`/tmp/diag/exit-mechanisms.mjs`；证据日志：`/tmp/diag/exit-request.log`。
- **待验证假设**：可见态 `document.exitPictureInPicture()` 能退出。
- **精确配置**：file:// fixture + 完整扩展；CDP 采样；页面可见。
- **实际观测**：promise 10s 未 settle（`resolvedAt:null`），pip 仍为 video。
- **结论**：F2（见 §1.1）。

### E5 · 18:26 `exit-disable` — `disablePictureInPicture` 两态对比

> 脚本：`/tmp/diag/exit-mechanisms.mjs`；证据日志：`/tmp/diag/exit-disable.log`。
- **待验证假设**：设置 `disablePictureInPicture=true` 可退出。
- **实际观测**：**隐藏**期间设置 → 1.5s 后 pip→none、`leaveEvents:1`；此前可见态设置无效。
- **结论**：F3、X6。

### E6 · 18:25 `exit-baseline` — 隐藏态退出基线

> 脚本：`/tmp/diag/exit-mechanisms.mjs`；证据日志：`/tmp/diag/exit-baseline.log`。
- **实际观测**：`document.exitPictureInPicture` → `"resolved"`，pip→none，`leaveEvents:1`。
- **结论**：F1。

### E7 · 17:5x — **原生自动关闭的组件级对照（关键）**
- **待验证假设**：哪个扩展组件破坏了 Chrome 的原生自动关闭。
- **精确配置**：file:// fixture（来自 `tests/e2e/fixtures/native-video.html`）；临时扩展只放指定文件；会话内用 Playwright 切换标签；3 轮。
  - case0 不加载扩展
  - case1 只加载 `native-pip-bridge.js`（MAIN world）
  - case2 只加载 `content.js`（all_frames, document_start）
  - case3 完整扩展（bridge + content）
  - case4 完整扩展 + `document.exitPictureInPicture` 计数器（neutralized）
- **实际观测**（`/tmp/split.txt`）：
  - case0：`backPip:none`、`leave` 递增 → **自动关闭 3/3**
  - case1：同 case0 → **自动关闭 3/3**，`nat:0`
  - case2：`backPip:video`、`leave:0`、`exitCalls:0` → **不关闭 3/3**
  - case3 / case4：`backPip:video`、`leave:0`、`exitCalls:0` → **不关闭**
- **结论**：F4–F7。**抑制者是 `content.js` 自身，与 bridge、与 exit 调用都无关。**
- **脚本**：`.probe-split.mjs`；输出 `/tmp/split.txt`。

### E8 · 18:5x — content.js 内部二分（**部分完成，含脚本崩溃**）
- **待验证假设**：content.js 哪一段代码抑制原生关闭。
- **精确配置**：临时扩展的 `content_scripts` 只放分片脚本；fixture `tests/e2e/fixtures/native-video.html`；3 轮。
  - group A：仅空 `visibilitychange` 监听
  - group B：`visibilitychange` + 隐藏时 `sendMessage({type:'pageHidden'})`
  - group C：B + `onMessage` 处理 `pip:tabActivated`（内联 exit）/ `pip:status`
  - group D：仅 `pip:status` 的 `onMessage` + 空 `visibilitychange` 监听
- **实际观测**（`/tmp/bisect2.txt`）：
  - group A：`backPip:none`、`leave` 递增 → **自动关闭 3/3**
  - group B：`backPip:none`、`leave` 递增 → **自动关闭 3/3**
  - group C：**无结果**；脚本在 B 之后崩溃：`cdpSession.send: Target page, context or browser has been closed`
- **结论**：H1 **被证伪**（仅 `pageHidden` 消息不构成抑制）；抑制源位于 C/D 覆盖的代码范围内，**尚未定位**。
- **数据缺口**：D2（group C）、D3（group D）。
- **脚本**：`.probe-bisect.mjs`；命令 `node .probe-bisect.mjs > /tmp/bisect2.txt 2>&1`。
- **下一步**：修正浏览器句柄复用后补齐 C/D。

### E9 · 17:56 `site` — site handler 在场（file:// + 完整扩展）

> **`[旧探针观测口径不足 / 被后续实验修正]`** 该轮探针把 `siteCalls` / `dispatcherCalls` / `nativeCallbacks` 当作「进入来源」的判据。后续实验证明这些内部回调计数不可靠（见 F8 改写），本轮**不得作为净结论**使用，仅保留原始观测。
- **配置**：file:// fixture（含 site handler）+ 完整扩展；`pip:status` → `{siteHandler:true, dispatcher:false, allowed:true}`。
- **实际观测**：3 轮每轮 `siteCalls` +1、`requestPictureInPicture ok`、`backPip:video`（不关闭）。
- **结论**：进入由 site handler 驱动；退出仍被 content.js 抑制。日志 `/tmp/diag/site.log`。

### E10 · 17:56 `no-site` — 无 site handler（file:// + 完整扩展）

> **`[旧探针观测口径不足 / 被后续实验修正]`** 同上：该轮以 `dispatcher` 是否被调用推断进入来源，口径不足，不得作为净结论。
- **配置**：file:// fixture 去掉 site handler + 完整扩展；`pip:status` → `{siteHandler:false, dispatcher:true, allowed:true}`。
- **实际观测**：`firstSeenMs≈120` 进入；3 轮 `backPip:video`（不关闭）。
- **结论**：dispatcher 路径同样被抑制。日志 `/tmp/diag/no-site.log`。

### E11 · 17:57–17:58 — **dispatcher 是否被调用（早期结论，须与 X7 一并复核）**

> **`[旧探针观测口径不足 / 被后续实验修正]`** 本轮依赖探针对 `setActionHandler` 的覆盖与 `nativeCallLog` 计数。后续证实这类计数无法可靠区分「Chrome browser-initiated 分支」与「扩展 manual 事件分支」，因此本轮的 `dispatcherCalls:0` **只能当作观测记录，不能当作净结论**。
- **待验证假设**：扩展的 MAIN world dispatcher 是否真的收到回调。
- **精确配置**：file:// fixture + 完整扩展；页面探针记录 `nativeCallLog` / `dispatcherCalls`；MAIN world 探针覆盖 `setActionHandler`。
- **实际观测**：
  - `dispatcher-calls.log`：`dispatcherCalls:0`、`enterEvents:1`，3 轮一致
  - `registration-audit.log`：`nativeCallLog:[]`、`seen:['manual']`
  - `dispatch-proof.log`：`regLog:['probe-installed']`、`last:null`（覆盖注册成功但 dispatcher 未触发）
  - `bridge-presence.log`：MAIN world `setActionHandler.name === 'wrappedSetActionHandler'`（bridge 安装成功）
- **当时结论**：dispatcher **未被调用**，进入 PiP 由 Chrome 原生路径完成。
- **状态**：`[后续修正]` 该观测本身未被证伪，但由此推出的「扩展不参与 → 所以是 Chrome 自己关闭」因果链后来写成 X7，而 X7 已撤回，须一并复核。
- **日志**：`/tmp/diag/dispatcher-calls.log`、`registration-audit.log`、`dispatch-proof.log`、`bridge-presence.log`。

### E12 · 18:26 — 退出手段穷举（隐藏态）
- **配置**：file:// fixture + 完整扩展；隐藏期间依次尝试 baseline / request-exit / pause-resume / disable / exit-action。
- **实际观测**：baseline、request-exit、pause-resume、disable 在隐藏期间均 pip→none 且 `leaveEvents:1`；exit-action 因非法枚举值 TypeError。
- **结论**：F1、F3、X4、X5、X6。日志 `/tmp/diag/exit-*.log`。

### E13 · 17:08–17:09 — file:// 原生探针（**无扩展基线 + handler 延迟变量**）
- **配置**：`/private/tmp/pip-probe/native/file-native.mjs`；file:// fixture；**无扩展**；唯一一次真实点击；`osascript` 激活 Chrome for Testing。
- **实际观测**：3 轮 `backPip:none`、`siteCallsAway` 递增、派发 `leavepictureinpicture` → **自动关闭**。
- **附加变量**：`HANDLER_DELAY_MS=180`（handler 内延迟 180ms 再 `requestPictureInPicture`）同样 3/3 自动关闭。
- **结论**：支持 F4；并且证明**站点 handler 在场本身不阻止自动关闭**。
- **状态**：`[后续修正]` 后续 X9 曾把 file:// 当成变量，与 E13 矛盾；现已回归 F4。
- **日志**：`/private/tmp/pip-probe/native/file-native-rounds3.log`、`file-native-delay180.log`。

### E14 · 17:56 `site` — file:// + site handler + **完整扩展**（**冲突条目**）

> **`[旧探针观测口径不足 / 被后续实验修正]`** 该轮把「site handler 在场」当作不关闭的原因，属于口径不足下的错误归因。
- **配置**：file:// fixture（site handler 在场）+ 完整扩展。
- **实际观测**：3 轮 `backPip:video`（不关闭），`siteCalls` 每轮 +1。
- **当时结论**：**「fixture 自带 handler 会阻止原生关闭」**。
- **状态**：`[后续证伪]` **该归因已被 E7 修正**——site handler 在场不影响自动关闭（E13），真正的变量是 content.js。原始证据保留：`/tmp/diag/site.log`。

### E15 · 时间待补 — http://127.0.0.1 复现（**冲突条目，曾推翻 E14 的归因**）
- **配置**：`chrome.tabs.create` 打开的 http fixture + 完整扩展。
- **实际观测**：自动关闭 3/3（F13）。
- **当时结论**：**「file:// 是变量，改用 http 即可修复」**。
- **状态**：`[后续证伪]` 该结论已被 X9 撤回；但它与 E13/E14 的三方冲突**尚未仲裁**。
- **数据缺口**：**D1 —— 原日志路径与完整配置待补**，这是当前最大的记账缺口。

---

### E16 · 执行前登记 — E8 group B 复现（**本条目在运行前登记**）

- **批准来源**：root 明确只批准这一个实验；不得顺手跑 group C/D 或其它任何实验。
- **待验证假设**：content.js 在页面隐藏时发送 `chrome.runtime.sendMessage({type:'pageHidden'})` 这**一个动作**，是否单独构成对 Chrome 原生自动关闭的抑制（H1）。
- **与 group A 的唯一差异**：group A 是空 `visibilitychange` 监听（已 3/3 通过自动关闭，属新基线）；group B 在 `visibilitychange` 里增加 `if (document.visibilityState !== 'hidden') return;` 加一次 `chrome.runtime.sendMessage({type:'pageHidden'})`。**除此之外完全一致**：同一 fixture、同一分片方式、同一 `content_scripts` 形状、同一轮数、同一采样方式。
- **精确配置**：
  - fixture：`tests/e2e/fixtures/native-video.html`
  - 临时扩展：`manifest.json` 的 `content_scripts = [{matches:['<all_urls>'], js:['sliced.js'], all_frames:true, run_at:'document_start'}]`，`sliced.js` == `S_VIS_PAGEHIDDEN`
  - 随扩展一起拷贝：`background.js`、`popup.html`、`icons/*`（与 group A 相同）
  - 不加载 `native-pip-bridge.js`、不加载真实 `content.js`
  - 激活方式：`osascript` 激活 Chrome for Testing + `page.bringToFront()` / `otherPage.bringToFront()` 切换标签
  - 采样：CDP `Runtime.evaluate{userGesture:false, awaitPromise:true}`
  - 轮数：3
- **操作步骤**：点击 `#play` 触发原生自动 PiP → 切到 other 标签等待进入 PiP → 切回 fixture → 4.5s 后采样 `pip` / `leaveEvents` / `visibility`。
- **期望（写在此处，事后不得修改）**：若 H1 成立，group B 应与「真实 content.js」一致 —— `backPip:video`、`leave:0`（不自动关闭）。若 group B 与 group A 一样 `backPip:none`、`leave` 递增，则 H1 被证伪。
- **日志路径**：`/tmp/bisect-B.txt`
- **执行命令**：`node .probe-bisect-b.mjs > /tmp/bisect-B.txt 2>&1`（脚本 `.probe-bisect-b.mjs` 为 `.probe-bisect.mjs` 去掉 A/C/D 三组调用后的**单组版本**，内容与 group B 定义逐字一致，`node --check` 通过）
- **执行时间**：2026-09-21，单次运行，3 轮。
- **退出码**：0（脚本未崩溃，三组完整跑完，无 CDP 断连）
- **原始观测**（`/tmp/bisect-B.txt`，逐字）：

  ```
  ### B vis + pageHidden msg
     {"round":1,"enteredPip":"video","backPip":"none","leave":1,"vis":"visible"}
     {"round":2,"enteredPip":"video","backPip":"none","leave":2,"vis":"visible"}
     {"round":3,"enteredPip":"video","backPip":"none","leave":3,"vis":"visible"}
  ```

  逐项解读：3 轮全部 `enteredPip:video`（确实进入了原生自动 PiP）；每轮 `backPip:none`（返回后已被自动关闭）；`leave` 从 1 递增到 3（每轮派发一次真实 `leavepictureinpicture`）；`vis:visible`（采样时页面确实已回到前台）。
- **结论**：**与期望相反 —— H1 被证伪。** 仅增加「隐藏时 `chrome.runtime.sendMessage({type:'pageHidden'})`」并**不会**抑制 Chrome 的原生自动关闭；group B 与 group A 表现完全一致（都 3/3 自动关闭）。
- **对 §1.3 的影响**：H1 由「E8 group B 已证伪（待复核）」升级为**已复现确认的证伪结论**，证据路径 `/tmp/bisect-B.txt`。
- **对 §1.1 的影响**：none（本次未产生新的 F 级结论）。但需注意：group B 不含 `onMessage` handler，也**不会**触发扩展的退出逻辑，因此「自动关闭仍然发生」这一结果同时再次说明**自动关闭的抑制源并不在 `pageHidden` 这一路径上**。
- **数据缺口不变**：D2（group C）、D3（group D）仍未跑、且**未获批准**，保持缺口状态。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
### E17 · 执行前登记 — E8 group D 复现（**本条目在运行前登记**）

- **批准来源**：root 明确只批准这一个实验；**不得跑 group C 或其它任何实验**。
- **待验证假设**：content.js 的 `chrome.runtime.onMessage` **处理器注册本身**（状态消息监听）是否单独构成对 Chrome 原生自动关闭的抑制（H2）。
- **与基线的差异**：基线与 E16 group A 相同 —— 只挂一个空 `visibilitychange` 监听（已 3/3 通过自动关闭）。group D 在此基础上**只增加** `chrome.runtime.onMessage.addListener(...)`。**明确不包含**：不发送 `pageHidden`（`visibilitychange` 保持为空）、不加 auto-pip bridge 事件处理（无 `auto-pip:enter` / `auto-pip:manual-toggle` / `auto-pip:native-state`）、不注册任何 MAIN world handler、不加载 `native-pip-bridge.js`。
- **实际加入的 handlers（逐个列出）**：
  1. `pip:status` —— 同步 `sendResponse({...})`，返回 `undefined`。**为保持与真实 content.js 一致，响应体字段逐个照抄**：`enabled`（取自 `settings.enabled`）、`state`（`document.pictureInPictureElement ? 'pip' : (pickVideo() ? 'playing' : 'idle')`）、`pipAvailable`（`!!document.pictureInPictureEnabled`）、`needsGesture`、`lastError`、`exitOnReturn`、`nativeAutoPip`（浅拷贝）。
  2. `pip:tabActivated` —— `if (settings.exitOnReturn) void exitPictureInPicture();` 返回 `undefined`。**这是本轮唯一会真正调用退出的分支**，只有在后台真的推送 `pip:tabActivated` 时才会执行。
  3. `pip:toggle` —— `void togglePictureInPicture().then(sendResponse);` 返回 `true`（异步回复）。
  4. 非对象 / 其它 `type` —— 返回 `undefined`（与真实实现一致）。

  > 诚实声明：真实 content.js 的 handler 直接引用模块内闭包 `settings`、`needsGesture`、`lastError`、`nativeAutoPip`、`currentState()`、`pickVideo()`、`togglePictureInPicture()`、`exitPictureInPicture()`。分片版无法整体搬入这些依赖，因此以上 4 个 handler 的**注册形状、分支顺序与返回语义逐字照抄**，被引用到的外部值以同名占位实现（`settings` 从 `chrome.storage.sync.get` 取默认值，其余按语义给出等价最小实现）。此差异登记为 **D4 的一部分**，属于本轮结论外推性限制。

- **精确配置**：
  - fixture：`tests/e2e/fixtures/native-video.html`
  - 临时扩展：`content_scripts = [{matches:['<all_urls>'], js:['sliced.js'], all_frames:true, run_at:'document_start'}]`，`sliced.js` == `S_VIS_ONLY_WITHTAB`（该定义已存在于 `.probe-bisect.mjs` 中，本轮不改写其内容）
  - 随扩展一带拷贝：`background.js`、`popup.html`、`icons/*`（与基线相同）
  - 不加载 `native-pip-bridge.js`、不加载真实 `content.js`
  - 激活：`osascript` 激活 Chrome for Testing + `page.bringToFront()` / `otherPage.bringToFront()` 切换标签
  - 采样：CDP `Runtime.evaluate{userGesture:false, awaitPromise:true}`
  - 轮数：3
- **操作步骤**：点击 `#play` 触发原生自动 PiP → 切到 other 标签等待进入 PiP → 切回 fixture → 4.5s 后采样 `pip` / `leaveEvents` / `visibility`。
- **期望（写在此处，事后不得修改）**：若 H2 成立（onMessage 注册是抑制源），group D 应与真实 content.js 一致 —— `backPip:video`、`leave:0`。若与基线一样 `backPip:none`、`leave` 递增，则 H2 被证伪。
- **日志路径**：`/tmp/bisect-D.txt`

- **执行命令**：`node .probe-bisect-d.mjs > /tmp/bisect-D.txt 2>&1`
- **脚本说明（两处偏离，如实登记）**：
  1. `.probe-bisect-d.mjs` 是本组**单组版本**（去掉 A/B/C 三组调用），其余调度逻辑逐字沿用 `.probe-bisect.mjs`，`node --check` 通过。
  2. **`.probe-bisect.mjs` 里原有的 D 分片是个占位桩**：它的 `pip:status` 只回 `{ok:true}`，且**完全没有** `pip:toggle` / `pip:tabActivated` 分支。按本轮批准范围「仅加入 content.js 的 runtime.onMessage 处理器（pip:status / pip:toggle / pip:tabActivated 等状态消息监听）」，我把 D 分片替换为**逐字镜像真实 content.js 的 handler**：相同的四条分支顺序、相同的 `sendResponse` 字段集合、相同的异步回复 `return true`。被真实 handler 引用的闭包值（`settings` / `needsGesture` / `lastError` / `nativeAutoPip` / `currentState()` / `pickVideo()` / `togglePictureInPicture()` / `exitPictureInPicture()`）以**同名占位**给出最小等价实现。这是对已登记 D4 限制的具体化。
- **执行时间**：2026-09-21，单次运行，3 轮。
- **退出码**：0（脚本完整跑完 3 轮，无 CDP 断连）
- **原始观测**（`/tmp/bisect-D.txt`，逐字）：

  ```
  ### D status/onMessage + empty vis
     {"round":1,"enteredPip":"video","backPip":"none","leave":1,"vis":"visible"}
     {"round":2,"enteredPip":"video","backPip":"none","leave":2,"vis":"visible"}
     {"round":3,"enteredPip":"video","backPip":"none","leave":3,"vis":"visible"}
  ```

  逐项解读：3 轮全部 `enteredPip:video`（确实进入了原生自动 PiP）；每轮 `backPip:none`（返回后已被自动关闭）；`leave` 1→3（每轮一次真实 `leavepictureinpicture`）；`vis:visible`（采样时已回到前台）。
  **重要**：`backPip:none` 说明退出发生了，而 `leave` 递增说明是**浏览器自己关的**（真实 leave 事件），并且本轮 `visibilitychange` 是空监听、也没有 `pageHidden` 消息，所以**没有任何扩展代码调用过 exit**。
- **结论**：**与期望相反 —— H2 被证伪。** 仅注册 content.js 的 `onMessage` 状态处理器（`pip:status` / `pip:toggle` / `pip:tabActivated`）**不会**抑制 Chrome 的原生自动关闭；group D 与 group A、group B 三者表现完全一致（都 3/3 自动关闭）。
- **对 §1.3 的影响**：H2 由「未跑、数据缺失」升级为**已复现的证伪结论**，证据 `/tmp/bisect-D.txt`；D3 缺口关闭。
- **对 §1.1 的影响**：none（本次未产生新的 F 级结论）。但与 E16 合并后的推论是实质性的：**group A / B / D 三个互不重叠的最小增量片段都不会抑制自动关闭**，因此抑制源必然落在**尚未被任一已跑分组覆盖**的其余 content.js 代码里（`visibilitychange` 主体逻辑、`auto-pip:*` 事件处理、`askServiceWorker` 复核流程、设置初始化等），或落在分片方式与真实 content.js 的差异上（D4）。
- **仍未跑**：group C（未获批准），**不得**顺手补跑。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
### E18 · 执行前登记 — E8 group C 复现（**B + D 组合交互测试，本条目在运行前登记**）

- **批准来源**：root 明确只批准这一个实验；**不得跑其它实验**。
- **待验证假设**：B 与 D 两个**已各自证伪单独抑制能力**的片段，**组合在一起**是否产生交互效应、从而抑制 Chrome 的原生自动关闭（H7）。这是组合交互测试，**不是** H1 或 H2 的重复验证。
- **组成（严格 = B 的 pageHidden 分片 + D 的镜像 onMessage handlers + 空 visibilitychange 基线）**：
  1. `visibilitychange` 监听：**不是空的**，而是沿用 E16（group B）那一版 —— `if (document.visibilityState !== 'hidden') return;` + 一次 `chrome.runtime.sendMessage({ type: 'pageHidden' }, () => { void chrome.runtime.lastError; })`。
  2. `chrome.runtime.onMessage.addListener(...)`：**逐字沿用 E17（group D）的镜像版**，四条分支完全一致 —— `pip:status`（同步 `sendResponse`，字段集合同 D）、`pip:tabActivated`（`exitOnReturn` 时 `void exitPictureInPicture()`）、`pip:toggle`（`void togglePictureInPicture().then(sendResponse)`，`return true`）、非对象/其它类型 `return undefined`。
  3. 占位依赖：与 E17 相同的同名占位（`settings` / `needsGesture` / `lastError` / `nativeAutoPip` / `pickVideo` / `currentState` / `exitPictureInPicture` / `togglePictureInPicture`），属已登记 D4 限制。
- **明确排除（本轮不得加入）**：任何 `auto-pip:*` 事件处理（`auto-pip:enter` / `auto-pip:manual-toggle` / `auto-pip:native-state`）；设置初始化之外的其它 content 逻辑；`native-pip-bridge.js`；真实 `content.js`。脚本已断言 `auto-pip:` 出现次数为 0。
- **精确配置**：fixture `tests/e2e/fixtures/native-video.html`；临时扩展 `content_scripts = [{matches:['<all_urls>'], js:['sliced.js'], all_frames:true, run_at:'document_start'}]`；随扩展一带拷贝 `background.js` / `popup.html` / `icons/*`（与基线相同）；`osascript` 激活 + `bringToFront()` 切标签；CDP 采样；3 轮。
- **操作步骤**：点击 `#play` 触发原生自动 PiP → 切到 other 标签等待进入 → 切回 fixture → 4.5s 后采样 `pip` / `leaveEvents` / `visibility`。
- **期望（写在此处，事后不得修改）**：A、B、D 三组已知都 3/3 自动关闭。若 C 与它们一致（`backPip:none`、`leave` 递增），则**「抑制源不在 B、D 及其简单组合中」得到确认**，H7 证伪。若 C 出现 `backPip:video`、`leave:0`（即抑制发生），则说明 B 与 D 存在**交互效应**，抑制源就在这两段的交叉点上。
- **日志路径**：`/tmp/bisect-C.txt`

- **执行命令**：`node .probe-bisect-c.mjs > /tmp/bisect-C.txt 2>&1`
- **脚本说明**：`.probe-bisect-c.mjs` 是基于 E17 的 `.probe-bisect-d.mjs` 派生 —— 把它唯一执行的那一组换成 B+D 组合分片（`S_VIS_BPLUS_HANDLERS`），并把 case 标签改为 `C vis + pageHidden + mirrored handlers`。其余调度、采样、轮数逻辑逐字不变。`node --check` 通过。
  **组合构造已做静态核对**：C 分片的 `onMessage` 块与 E17 使用的 D 分片逐字相同（同一份镜像版）；`visibilitychange` 块与 E16 使用的 B 分片在语义上逐字相同（同样的 `hidden` 早退 + 同样的 `pageHidden` 发送 + 同样的 `chrome.runtime.lastError` 吞掉）。
- **执行时间**：2026-09-21，单次运行，3 轮。
- **退出码**：0（脚本完整跑完 3 轮，无 CDP 断连）
- **原始观测**（`/tmp/bisect-C.txt`，逐字）：

  ```
  ### C vis + pageHidden + mirrored handlers
     {"round":1,"enteredPip":"video","backPip":"none","leave":1,"vis":"visible"}
     {"round":2,"enteredPip":"video","backPip":"none","leave":2,"vis":"visible"}
     {"round":3,"enteredPip":"video","backPip":"none","leave":3,"vis":"visible"}
  ```

  逐项解读：3 轮全部 `enteredPip:video`；每轮 `backPip:none`（返回后已被自动关闭）；`leave` 1→3；`vis:visible`。与 A / B / D 三组**完全同形**，无任何差异。
- **结论**：**H7 被证伪 —— 不存在交互效应。** B（`pageHidden` 消息）与 D（`onMessage` handlers）组合后，Chrome 的原生自动关闭照常发生，3/3 与三个单片段组一致。
- **对 §1.3 的影响**：H7 由「正在验证」改为**已证伪并复现**。D2（group C）缺口关闭。
- **对 §1.1 的影响**：none（无新 F 级结论）。但现在四组证据可以合并成一条**强推论**：

  > group A（空 visibility 监听）、B（+ `pageHidden` 发送）、D（+ 镜像 `onMessage` handlers）、C（B+D 组合）中，**没有任何一组抑制自动关闭**。这四组合起来覆盖了 content.js 的 `visibilitychange` 早退分支、`pageHidden` 发送、以及全部三条 `onMessage` 状态分支 —— 也就是说，**content.js 中「页面向后台发消息」与「接受后台消息」这两条通信通道整体都不是抑制源**。抑制源因此必须落在剩余代码里：`visibilitychange` 的**主体分支逻辑**（`pickVideo()`、700ms 等待原生 dispatcher 的循环、`askServiceWorker` 复核后 `enterPictureInPicture({automatic:true})`、`nativeEntryInFlight`/`autoSuppressed`/`visibilityVersion` 这些状态机）、`auto-pip:*` 事件处理、设置初始化，或落在分片方式与真实 content.js 的差异上（D4）。
  
  > 值得注意：剩下最可疑的是 `visibilitychange` **主体逻辑**本身，而本轮与 E16/E17 都没有测它；它是唯一「在返回时主动做事情」的代码。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
- **执行命令**：`node .probe-E19.mjs > /tmp/E19.txt 2>&1`（脚本 `.probe-E19.mjs` 由 `.probe-split.mjs` 的 case1 形状改写而来，只加载 `native-pip-bridge.js`，增量仅为页面加载后派发一次 `auto-pip:config`；`node --check` 通过，且 grep 确认脚本内无 `content.js` / `visibilitychange` / `pageHidden` / `onMessage`）
- **执行时间**：2026-09-21 19:09（第一次运行于 19:06 被外层超时杀掉，日志只有注册确认 4 行、无轮次结果；脚本未改动，做了第二次干净重跑）
- **退出码**：0
- **原始观测**（`/tmp/E19.txt`，逐字）：

  ```
  native-state BEFORE config = []
  config dispatch = dispatched
  native-state AFTER config = [{"site":false,"dispatcher":true,"allowed":true}]
  DISPATCHER REGISTERED (dispatcher===true && allowed===true) = true
  ### E19 case1 baseline + one auto-pip:config
     {"round":1,"entered":false,"dispatcher":"{\"site\":false,\"dispatcher\":true,\"allowed\":true}"}
     {"round":2,"entered":false,"dispatcher":"{\"site\":false,\"dispatcher\":true,\"allowed\":true}"}
     {"round":3,"entered":false,"dispatcher":"{\"site\":false,\"dispatcher\":true,\"allowed\":true}"}
  ```

- **增量生效的证据**：配置前的 `auto-pip:native-state` 广播序列为**空数组**（与源码推论一致：只加载 bridge 时没有任何代码派发 `auto-pip:config`，`allowed` 恒为 `false`，且桥接脚本加载尾部的 `announce()` 早于 fixture 的 listener 注册，因此序列为空而非 `[{site:false,dispatcher:false,allowed:false}]` —— 这一点属于本轮观测，登记为口径说明）；派发一次 `auto-pip:config {enabled:true, exitOnReturn:true}` 后广播为 `{site:false, dispatcher:true, allowed:true}`，断言 `dispatcher===true && allowed===true` 为 `true`，确认 `applyAllowance() → registerDispatcher()` 已执行。
- **结果**：3 轮全部 `entered:false` —— **一次都没有进入 PiP**；回切前台后同样没有 `leavepictureinpicture` 事件（因为从未进入）。
- **结论（已按 root 指定的口径记账）**：
  1. **E7 case1 与真实 dispatcher 路径非同构**：case1 全程 `allowed === false`、`dispatcherRegistered === false`，Chrome 因此走 browser-initiated 自动进入分支；F5「只加载 bridge 时仍自动关闭 3/3」这一结论只在 **allowed=false 且 dispatcher 未注册**的条件下成立，不能外推到 dispatcher 已注册的路径。
  2. **E19 的 `entered:false` 在「无人处理 `auto-pip:enter`」的前提下属于预期**：bridge 的 `bridgeDispatcher()` 在隐藏态只做一件事 —— `sendEvent(ENTER_EVENT, {})`；它自己**不调用** `requestPictureInPicture()`。页面侧没有任何 `auto-pip:enter` 监听器（本轮明确排除 content.js、排除任何页面 handler），因此回调虽然没有接收方，进入自然不会发生。
  3. **不得由 E19 推出「dispatcher 未派发」或「Chrome 走了 manual 分支」**：本轮只证明了 dispatcher 已注册（`dispatcher:true && allowed:true`），**没有**观测 `auto-pip:enter` 的到达情况，也没有观测 media session action 的接收方。`entered:false` 与「dispatcher 未派发」之间不构成证据关系。
  4. E19 对 §1.1 **不做新增 F 级结论**；它改变的是 F5 的**适用边界**（需附加 `allowed=false / dispatcher 未注册` 这一限定），并把「dispatcher 注册后的进入条件」登记为新的待验证项（H9）。
- **对 H8 的影响**：H8 的原表述（「真正注册 dispatcher 并 `allowed:true` 后自动关闭就不再发生」）在本轮**不可判定** —— 前提「先进入」没有达成，因此「是否自动关闭」无从观测。H8 保留但降级为**部分阻塞**，等待 H9 先解答进入条件。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
### E19 · 执行前登记 — case1 基线 + 一次 `auto-pip:config`（**本条目在运行前登记**）

- **批准来源**：root 明确只批准这一个实验；**不得跑其它实验**。
- **待验证假设**：H8 —— E7 case1 里「只加载 MAIN bridge + 返回自动关闭 3/3」这一结果，是否其实发生在 **dispatcher 未注册 / `allowed:false`** 的状态下；一旦按真实扩展的方式把 `auto-pip:config` 广播过去、让 dispatcher 真正注册并 `allowed:true`，自动关闭是否就不再发生。
- **基线回顾（E7 case1 的 dispatcher 此前是否实际为 `false` / 未配置）**：**是，未配置即未注册。** 依据来自 `native-pip-bridge.js` 源码，不是猜测：
  1. `let allowed = false;` —— 初始值就是 `false`。
  2. 唯一的写入口是 `document.addEventListener(CONFIG_EVENT, ...)` 里的 `allowed = Boolean(detail.enabled && detail.exitOnReturn);`。
  3. `applyAllowance()` 只有在 `allowed && !siteHandler` 时才调用 `registerDispatcher()`，而 `registerDispatcher()` 才是唯一把 `dispatcherRegistered` 置为 `true` 的地方。
  4. E7 case1 的临时扩展**只放了 `native-pip-bridge.js`，没有 `content.js`**，因此**没有任何代码派发过 `auto-pip:config`**（真实 content.js 才是派发方）。
  ⇒ 由 (1)(2)(3)(4)：case1 全程 `allowed === false`、`dispatcherRegistered === false`，`announce()` 广播出去的 `auto-pip:native-state` 里 `dispatcher:false`。
  **这是重要前提**：E7 case1「自动关闭 3/3」是在 **dispatcher 从未注册**的条件下取得的，因此 case1 与真实扩展（dispatcher 已注册）并不同构；F5 的结论需要在这一限定下理解。
- **与基线 case1 的唯一增量**：在**页面加载完成后**，由**被测页面自身**派发（dispatcher 只在页面 realm 内监听该事件）**一次** `auto-pip:config`，`detail = {enabled:true, exitOnReturn:true}`。除此之外与 case1 完全一致。
- **明确排除（本轮不得加入）**：不加载 `content.js`；不加任何 `visibilitychange` 逻辑；不加 `onMessage` 处理器；不发送 `pageHidden`；不派发任何其它 `auto-pip:*` 事件。
- **dispatcher 注册的可观察确认方式**（必须拿到，作为「增量确实生效」的证据，而不是只看 `allowed`）：
  - 主证据：在 fixture 中监听 `document` 上的 `auto-pip:native-state` 事件，记录全部广播。
  - 成功判据：至少一次广播满足 `detail.dispatcher === true && detail.allowed === true`（`registerDispatcher()` 在把 `dispatcherRegistered` 置 `true` 后立即 `announce()`）。
  - 双向校验：同时记录该事件序列的**第一个**广播，预期为 `{site:false, dispatcher:false, allowed:false}`（来自桥接脚本加载尾部的 `announce()`），用以确认「增量之前确实是未注册态」。
- **精确配置**：fixture `tests/e2e/fixtures/native-video.html`（不注册 site handler 的变体不可用，本轮沿用带 site handler 的 fixture，但**不派发**任何 site handler 相关逻辑；若 fixture 自带 site handler 会导致 `registerDispatcher()` 因 `siteHandler` 非空而提前返回，则该事实必须如实记录并判定本轮无效）；临时扩展 `content_scripts = [{js:['native-pip-bridge.js'], run_at:'document_start', world:'MAIN', all_frames:false}]`；随扩展一带拷贝 `background.js` / `popup.html` / `icons/*`；`osascript` 激活 + `bringToFront()` 切标签；CDP 采样；3 轮。
- **操作步骤**：加载 fixture → 派发一次 `auto-pip:config` 并等待可观察状态确认 dispatcher 已注册 → 点击 `#play` 触发原生自动 PiP → 切到 other 标签等待进入 → 切回 fixture → 采样 `pip` / `leaveEvents` / `visibility` / dispatcher 状态。
- **期望（写在此处，事后不得修改）**：若 H8 成立，本轮应出现与 case1 相反的 `backPip:video`、`leave:0`（dispatcher 注册后不再自动关闭）。若仍 `backPip:none`、`leave` 递增，则 H8 被证伪 —— 说明即使 dispatcher 真正注册并 `allowed:true`，也不抑制自动关闭。
- **日志路径**：`/tmp/E19.txt`
- **执行命令**：`node .probe-E23.mjs 2>&1 | tee /tmp/E23.txt`（探针以 --load-extension=/Users/tpjtz/code/tools/pip-chrome-plugin **原样**加载整个工作区扩展，仅用 CDP 观测，不改写任何产品文件）。
- **结果（运行后补记）**：**3/3 轮全部通过**，满足全部四条判据：
  - 进入：away.pip === "video"，enterEvents 1/2/3 每轮递增 —— 3/3 进入成功。
  - 浏览器自行关闭：back.pip === "none"，leaveEvents 1/2/3 每轮递增 —— 3/3 由浏览器关闭，**未出现 E22 的「卡在打开」**。
  - 不在可见态显式退出：visibleExitCalls === 0（全程），exitCalls 全程为空数组 —— 扩展**从未**调用 document.exitPictureInPicture()。
  - 可重复进入：第 2、3 轮仍能进入，说明 native leave 后的 autoSuppressed / exiting 复位有效。
  - 原始逐轮数据：
    - R1 away{pip:video,enterEvents:1} → back{vis:visible,pip:none,leaveEvents:1,visibleExitCalls:0,exitCalls:[]}
    - R2 away{pip:video,enterEvents:2} → back{vis:visible,pip:none,leaveEvents:2,visibleExitCalls:0,exitCalls:[]}
    - R3 away{pip:video,enterEvents:3} → back{vis:visible,pip:none,leaveEvents:3,visibleExitCalls:0,exitCalls:[]}
- **对 H13 的判定**：**成立**（4 条子判据全部满足）。E22 的「PiP 卡在打开」在**受控单变量条件**下被修复，且在**原样加载的真实扩展**上复现通过。
- **对 §1.1 的影响**：新增 **F14**（受限表述：仅限本轮受控环境），F6 补「经 E22 纠正」再归因。
- **对 §1.3 的影响**：新增 **H13**（成立）。
- **对 §1.4 的影响**：新增 **N12**（禁止把「原样加载真实扩展的三轮验证」当作常规回归重跑；它只在产品修复候选变更时重跑）。
- **未跑其它实验**：本轮除 E23 外未运行任何其它实验；后续 npm test / E2E 另行登记。
### E20 · 执行前登记 — E19 同配置 + 页面侧 `auto-pip:enter` 处理（**本条目在运行前登记**）

- **批准来源**：root 明确只批准 E20 这一个实验；**不得跑其它实验**，且不得顺手加任何被排除项。
- **待验证假设**：**H9** —— dispatcher 已注册（`dispatcher:true && allowed:true`）时，`auto-pip:enter` 是否真的被派发；页面侧对该事件调用 `requestPictureInPicture()` 能否让 PiP 重新进入。
- **与 E19 的唯一差异**：在页面侧新增**一个** `document.addEventListener("auto-pip:enter", ...)`，回调里 `window.__enterCallbacks++` 并对 `document.querySelector("video")` 调用 `requestPictureInPicture()`，把 promise 结果（resolve / reject 的 `err.name`）逐次记录到 `window.__requestResults`。**除此之外与 E19 完全一致**：同一 fixture、同一临时扩展（只有 `native-pip-bridge.js`）、同样在页面加载后派发一次 `auto-pip:config {enabled:true, exitOnReturn:true}`、同一激活方式、同一轮数、同一采样点。
- **明确排除（本轮不得加入）**：不加载 `content.js`；不加任何 `visibilitychange` 逻辑；不发送 `pageHidden`；不加 `chrome.runtime.onMessage` 处理器；不加设置初始化/`chrome.storage` 逻辑。
- **精确配置**：fixture `tests/e2e/fixtures/native-video.html`（已 grep 确认其中**没有** `setActionHandler` / `mediaSession` 调用，因此 `registerDispatcher()` 不会因 `siteHandler` 非空而提前返回）；临时扩展 `content_scripts = [{matches:["<all_urls>"], js:["native-pip-bridge.js"], run_at:"document_start", world:"MAIN", all_frames:false}]`；随扩展一并拷贝 `background.js` / `popup.html` / `icons/*`；会话内 `page.bringToFront()` / `otherPage.bringToFront()` 切标签；CDP `Runtime.evaluate` 采样；3 轮。
- **操作步骤**：注册探针监听（native-state 全量广播 + `auto-pip:enter` 计数 + `requestPictureInPicture` promise 结果）→ 派发一次 `auto-pip:config` 并确认 `dispatcher:true && allowed:true` → 点击 `#play` → 切到 other 标签等待进入（最多 20s 轮询）→ 采样 away 状态与计数器 → 切回 fixture → 4.5s 后采样 back 状态、`enterEvents` / `leaveEvents`、计数器。
- **必须记录的字段**：每轮的 `auto-pip:enter` 回调次数（`enterCallbacks`）、`requestPictureInPicture` promise 结果（`requestResults`，含失败时的 `err.name`）、`enterpictureinpicture` / `leavepictureinpicture` 事件计数、away 与 back 两个时点的 `document.pictureInPictureElement` 状态、以及最后一次 `auto-pip:native-state` 广播。
- **期望（写在此处，事后不得修改）**：若 H9 成立，`enterCallbacks` 应 ≥1 且随轮次递增，`requestResults` 中出现成功项，away 时 `pip === "video"`、`enterEvents` 递增。若 `enterCallbacks` 恒为 0，则说明 `auto-pip:enter` 从未被派发（即 dispatcher 并未收到浏览器动作），H9 证伪且抑制源与本次进入无关；若出现回调但 `requestPictureInPicture` 被拒（如 `NotAllowedError`），则进入失败的原因是页面缺少用户激活，而非事件通道。
- **日志路径**：`/tmp/E20.txt`
- **执行命令**：`node .probe-E20.mjs > /tmp/E20.txt 2>&1`（脚本 `.probe-E20.mjs` 由 `.probe-E19.mjs` 改写，`node --check` 通过；grep 确认脚本内无 `content.js` / `visibilitychange` / `pageHidden` / `onMessage` / `settings`；`diff` 确认与 E19 的差异仅为本条目所述的一处增量与计数/输出字段）
- **执行结果**（已改为「运行后补记」，本节其余内容保持运行前原文未改）：
- **执行命令**：`node .probe-E20.mjs > /tmp/E20.txt 2>&1`
- **执行时间**：2026-09-21 19:12
- **退出码**：0（单次干净运行，3 轮完整跑完，无 CDP 断连）
- **原始观测**（`/tmp/E20.txt`，逐字）：

  ```
  native-state BEFORE config = []
  config dispatch = dispatched
  native-state AFTER config = [{"site":false,"dispatcher":true,"allowed":true}]
  DISPATCHER REGISTERED (dispatcher===true && allowed===true) = true
  ### E20 E19-equivalent config + page-side auto-pip:enter handler
     {"round":1,"away":{"pip":"video","enterEvents":1,"counter":{"enterCallbacks":1,"requestResults":[{"ok":true,"err":null,"at":1789989117787}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}},"back":{"pip":"none","leaveEvents":1,"enterEvents":1,"vis":"visible","counter":{"enterCallbacks":1,"requestResults":[{"ok":true,"err":null,"at":1789989117787}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}}}
     {"round":2,"away":{"pip":"video","enterEvents":2,"counter":{"enterCallbacks":2,"requestResults":[{"ok":true,"err":null,"at":1789989117787},{"ok":true,"err":null,"at":1789989124704}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}},"back":{"pip":"none","leaveEvents":2,"enterEvents":2,"vis":"visible","counter":{"enterCallbacks":2,"requestResults":[{"ok":true,"err":null,"at":1789989117787},{"ok":true,"err":null,"at":1789989124704}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}}}
     {"round":3,"away":{"pip":"video","enterEvents":3,"counter":{"enterCallbacks":3,"requestResults":[{"ok":true,"err":null,"at":1789989117787},{"ok":true,"err":null,"at":1789989124704},{"ok":true,"err":null,"at":1789989131671}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}},"back":{"pip":"none","leaveEvents":3,"enterEvents":3,"vis":"visible","counter":{"enterCallbacks":3,"requestResults":[{"ok":true,"err":null,"at":1789989117787},{"ok":true,"err":null,"at":1789989124704},{"ok":true,"err":null,"at":1789989131671}]},"lastNativeState":{"site":false,"dispatcher":true,"allowed":true}}}
  ```

- **逐字段结果**：
  - `auto-pip:enter` 回调次数：1 / 2 / 3（每轮 +1，3 轮共 3 次）—— **回调确实被派发**。
  - `requestPictureInPicture` promise 结果：3 次全部 `{ok:true, err:null}`，**无一被拒**（无 `NotAllowedError`）。
  - `enterpictureinpicture` 事件：1 / 2 / 3（与回调次数同步递增）。
  - away 时点 `document.pictureInPictureElement`：3 轮均 `video` —— **每轮都成功进入 PiP**。
  - back 时点（切回前台 4.5s 后）：3 轮均 `pip:none`、`vis:visible`。`leavepictureinpicture` 事件：1 / 2 / 3 —— **每轮都在返回时自动关闭**。
  - `auto-pip:native-state` 广播在每轮前后均为 `{site:false, dispatcher:true, allowed:true}`，全程未变。
- **结论**：
  1. **H9 成立**：dispatcher 已注册且 `allowed:true` 时，`auto-pip:enter` **确实被派发**（回调 3/3 到达），且页面侧对当前 video 调用 `requestPictureInPicture()` **每次都成功**（3/3 `{ok:true}`，无拒绝）。这与 E19 的 `entered:false` 合并后给出确定解释：**E19 未进入的唯一原因是页面侧没有人处理 `auto-pip:enter`**，而不是 dispatcher 未派发、也不是请求被拒。
  2. **H8 在本轮获得直接结果：证伪**。在 dispatcher 真正注册并 `allowed:true`、且进入确实发生的条件下，返回时**仍然 3/3 自动关闭**（`leaveEvents` 每轮 +1）。因此「真正注册 dispatcher 并 `allowed:true` 后自动关闭就不再发生」不成立；抑制源**不在 dispatcher 的注册状态**上。
  3. **F5 的边界被本轮进一步收紧**：E7 case1（`allowed=false`、dispatcher 未注册）之所以能自动关闭，与「dispatcher 已注册」的路径**都是自动关闭**，两者的可见结果一致，差别只在进入由谁触发（Chrome browser-initiated 分支 vs 页面 handler）。因此 F5 本身仍成立，但它**不能**用来支持「dispatcher 参与 → 关闭被抑制」这类推论。
  4. **抑制源排除法再前进一步**：本轮在「只有 bridge + 一次 config + 页面侧一个 enter handler」的最小集合下，自动关闭依然发生。这个集合**没有任何 content.js 代码**，因此抑制源必然在 content.js 的剩余部分（`visibilitychange` 主体逻辑、`auto-pip:*` 事件处理、设置初始化、或 D4 分片差异），与 E16/E17/E18 的推论方向一致、并首次在**进入确实发生**的条件下成立。
  5. 本轮**不**新增 F 级条目（未测 content.js 行为），但建议把「dispatcher 已注册且进入发生时的自动关闭行为」登记为候选条目（由 root 裁定是否升格）。**编号更正**：该候选后来**未被**采用为 F14 —— 正式 F14 是 E22 记录的「可见态 exit 调用挂起（F14*），此处旧称仅作历史保留。
- **对 §1.3 的影响**：H9 由「正在验证」改为**已验证成立**；H8 由「部分阻塞」改为**已证伪**。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
### E21 · 执行前登记 — E20 基线 + content.js `visibilitychange` **hidden 分支主体**（**本条目在运行前登记**）

- **批准来源**：root 明确只批准 E21 这一个实验；**不得跑其它实验**，且不得顺手加入任何被排除项。
- **待验证假设**：**H10** —— 在 E20 已完成「dispatcher 已注册且进入确实发生、返回仍 3/3 自动关闭」的前提下，把 content.js `visibilitychange` 的 **hidden 分支主体**逐段搬入页面，是否会让返回时的自动关闭消失（即该分支主体是否为抑制源）。
- **基线（E20，原样保留）**：bridge（`native-pip-bridge.js`，MAIN world）+ 页面加载后一次 `auto-pip:config{enabled:true, exitOnReturn:true}` + 页面侧一个 `auto-pip:enter` 监听 → `requestPictureInPicture()`。已知结果：3/3 进入、3/3 自动关闭。
- **与 E20 的唯一差异**：在**同一个页面 realm** 里新增一个 `visibilitychange` 监听器，其 hidden 分支按真实 content.js **逐段镜像**（visible 分支改为明确 no-op，见下）。E20 已有的 `auto-pip:enter` 监听器**保留不变**（因为真实 content.js 里也有它）。
- **逐段镜像清单**（每段对应 `content.js` 的确切行区间，均为**逐字**搬运）：
  1. `content.js:95–113` `isPlaying()` —— 逐字。
  2. `content.js:115–126` `collectVideos()` —— 逐字（含 Shadow DOM 回退）。
  3. `content.js:131–146` `scoreVideo()` —— 逐字。
  4. `content.js:148–166` `pickVideo()` —— 逐字。
  5. `content.js:310–320` `askServiceWorker()` —— 逐字，**额外只加一个 `pageHidden` 计数**（不改控制流）。
  6. `content.js:168–208` `enterPictureInPicture()` —— 逐字，闭包依赖用同名最小实现：`settings`（常量 `{enabled:true, exitOnReturn:true}`）、`autoSuppressed`、`entering`、`operationVersion`；`needsGesture` / `lastError` 属面板上报字段，本轮不参与控制流故省略（登记为 D7）。**fallback 进入计数**只加在 `await video.requestPictureInPicture()` 成功之后（不改控制流）。
  7. `content.js:301–307` `auto-pip:native-state` 监听（写 `nativeAutoPip`）—— 逐字。
  8. `content.js:364–392` `visibilitychange` 主体 —— hidden 分支逐字；**visible 分支按 root 要求改为 `return`（no-op）**，即移除真实的 `if (settings.exitOnReturn) await exitPictureInPicture();`。这是与真实代码的**唯一**差异，已登记为 **D7**（会低估真实代码的退出行为，因此本轮方向偏向「更不容易关闭」，即对 H10 是一个**保守**测试）。
  9. `content.js:22–30` 状态变量 `visibilityVersion` / `autoSuppressed` / `lastVisibility` / `nativeAutoPip` / `nativeEntryInFlight` —— 按原始初值建立。
- **明确排除（本轮不得加入）**：不加载 `content.js`；不加 `chrome.runtime.onMessage` 处理器（`pip:status` / `pip:toggle` / `pip:tabActivated`）；不加 `chrome.storage` 设置同步；不加 `auto-pip:enter` 的 **content.js 版本**（页面侧已有的最小版本保留，用于维持 E20 基线）；不加 `auto-pip:manual-toggle` / `auto-pip:native-state` 之外的 `auto-pip:*` 处理器；不加 `leavepictureinpicture → cancelAutomaticEntry`；不加 `auto-pip:bridge-ready` / `broadcastConfig()`。
- **「不调用 exit」的可证伪化**：真实 content.js 只会调用内部包装 `exitPictureInPicture()`（它先置 `autoSuppressed` 再调 `document.exitPictureInPicture`），**从不直接调用** `document.exitPictureInPicture`，也不改 video 属性。因此探针覆盖 `document.exitPictureInPicture` 计数（`realExitCalls`）可以在**不改变真实代码行为**的前提下，观测到「可见分支若发生退出」这一情形。若 `realExitCalls` 恒为 0，则「visible 分支 no-op」得到实证。
- **精确配置**：fixture `tests/e2e/fixtures/native-video.html`；临时扩展 `content_scripts = [{matches:["<all_urls>"], js:["native-pip-bridge.js"], run_at:"document_start", world:"MAIN", all_frames:false}]`；随扩展拷贝 `background.js`（**必须保留**，否则 `pageHidden` 无接收方，`askServiceWorker` 会解析为 `null`）/ `popup.html` / `icons/*`；`page.bringToFront()` / `otherPage.bringToFront()` 切标签；CDP `Runtime.evaluate` 采样；3 轮。
- **必须记录的字段（每轮）**：`auto-pip:enter` 回调次数与 `requestPictureInPicture` promise 结果；fallback 进入次数（`fallbackCalls`）；`pageHidden` 发送次数与后台 `tabSwitch` 回复序列；away / back 两个时点的 `document.pictureInPictureElement`；`enterpictureinpicture` / `leavepictureinpicture` 事件计数；`document.exitPictureInPicture` 被调次数（`realExitCalls`）；最后一次 `auto-pip:native-state` 广播。
- **期望（写在此处，事后不得修改）**：若 H10 成立，应观察到与 E20 相反的 `back.pip === "video"`、`leaveEvents:0`（自动关闭消失），且 `pageHidden` 有发送、`tabSwitch` 回复为 `true`。若仍 `back.pip === "none"`、`leaveEvents` 递增，则 H10 被证伪 —— 抑制源不在 `visibilitychange` hidden 分支主体里。若 `pageHidden` 次数为 0，说明上游早退（`!settings.enabled` / `pickVideo()` 返回 null / 700ms 等待期内的 `version` 失效），该轮须如实记录为**未触达被测代码**，不得据此判定 H10。
- **日志路径**：`/tmp/E21.txt`
- **执行命令**：`node .probe-E21.mjs > /tmp/E21.txt 2>&1`（脚本 `.probe-E21.mjs` 由 `.probe-E20.mjs` 改写，`node --check` 通过；grep 确认无 `chrome.runtime.onMessage`、无 `chrome.storage`；加载的文件只有 `native-pip-bridge.js`，`content.js` 仅出现在注释中）
- **执行结果**（已改为「运行后补记」，本节其余内容保持运行前原文未改）：
- **执行命令**：`node .probe-E21.mjs > /tmp/E21.txt 2>&1`
- **执行时间**：2026-09-21 19:15（第一次运行在沙箱内启动 Chrome 失败：`poll timeout: ENOENT ... DevToolsActivePort`，属环境限制；脚本未改动，加权限后重跑成功）
- **退出码**：0（3 轮完整跑完）
- **原始观测**（`/tmp/E21.txt`，节选关键字段；完整原文见日志文件）：

  ```
  native-state AFTER config = [{"site":false,"dispatcher":true,"allowed":true}]
  DISPATCHER REGISTERED (dispatcher===true && allowed===true) = true
  E21 arm installed; counters = {"pageHiddenCalls":0,...,"visLog":[]}
  round1 away: pip=video enterEvents=1 enterCallbacks=1 requestResults=[{ok:true}] pageHiddenCalls=1 fallbackCalls=0 realExitCalls=0
  round1 back: pip=none leaveEvents=1  vis=visible   pageHiddenCalls=1
  round2 away: pip=video enterEvents=2 enterCallbacks=2 requestResults=[ok,ok] pageHiddenCalls=2 fallbackCalls=0 realExitCalls=0
  round2 back: pip=none leaveEvents=2  vis=visible   pageHiddenCalls=2
  round3 away: pip=video enterEvents=3 enterCallbacks=3 requestResults=[ok,ok,ok] pageHiddenCalls=3 fallbackCalls=0 realExitCalls=0
  round3 back: pip=none leaveEvents=3  vis=visible   pageHiddenCalls=3
  replyTabSwitch = [] （3 轮全部为空，见「口径限制」）
  ```

- **逐字段结果**：
  - away / back 的 `document.pictureInPictureElement`：3 轮均为 away `video` → back `none`。
  - `auto-pip:enter` 回调与请求：`enterCallbacks` 1/2/3，`requestResults` 3/3 `{ok:true}`（与 E20 一致，基线未变）。
  - `pageHidden` 发送次数：1/2/3 —— **每轮都真的走到了 `askServiceWorker({type:"pageHidden"})`**，即 hidden 分支主体确实被执行到。
  - fallback 进入次数：**0**（符合预期：`enterCallbacks` 命中时 `document.pictureInPictureElement` 已存在，700ms 等待循环内的第 4 个条件会 `return`）。
  - `document.exitPictureInPicture` 被调次数：**0** —— 本轮不存在任何退出调用。
  - `visLog`：每轮恰好 `hidden → visible` 两跳，`visibilityVersion` 连续递增（1→2→3→4→5→6），无版本失效。
  - 进入事件 1/2/3 与离开事件 1/2/3 均同步递增。
- **结论**：
  1. **H10 被证伪**：在被测代码**确实被执行**（`pageHidden` 1/2/3 发送）的前提下，返回时**仍然 3/3 自动关闭**（`leaveEvents` 每轮 +1）。抑制源**不在** `visibilitychange` 的 hidden 分支主体内。
  2. 本轮同时再次确认（与 E20 同向）：**不存在任何退出调用**（`realExitCalls:0`），自动关闭与 `document.exitPictureInPicture()` 无关；它与 F4/F5 同源，是浏览器自己在返回时关掉的。
  3. 结合 E16/E17/E18（通信通道已排除）与 E20/E21（dispatcher 注册态、hidden 分支主体均已排除），**content.js 中尚未被覆盖的代码只剩**：`visibilitychange` 的 **visible 分支**（即 `exitPictureInPicture()`，但它只在返回时增加退出、不会抑制关闭）、`auto-pip:enter` 的 content.js 版本处理器、`auto-pip:manual-toggle`、设置初始化/`chrome.storage.sync` 同步、`leavepictureinpicture → cancelAutomaticEntry`、以及 `auto-pip:bridge-ready → broadcastConfig()`。这几项**按机制都不可能是「抑制浏览器自动关闭」的原因**（它们要么只做事、要么只在上层分支），这与「抑制源在 content.js 之外」的判断一致。
  4. **重要的下一步指向**：既然在「bridge 已注册 dispatcher + 进入确实发生」的条件下自动关闭依然发生，而 F6（只加载 content.js）却显示不关闭 —— 两者的差别**不在**本轮列出的 hidden 分支主体上，需要重新审视 F6 的对照组口径。**建议把 F6 列为待复核项**（本轮不擅自改动该结论）。
- **口径限制（如实登记）**：`replyTabSwitch` 三轮均为空数组，即 `chrome.runtime.sendMessage` 回调里那次记录**从未执行**。这与真实 content.js 的写法完全一致（回调里先读 `chrome.runtime.lastError` 再 resolve），因此判定为**探针口径问题**：该回调在扩展上下文被回收或 `lastError` 读取路径异常时不落记录。**这不影响本轮结论**：`pageHiddenCalls`（发送侧）已证明代码路径被执行，且「是否关闭」直接由 `pip`/`leaveEvents` 观测。登记为 **D8**。
- **对 §1.3 的影响**：H10 由「正在验证」改为**已证伪**。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
### E22 · 执行前登记 — E21 基线 + visible 分支恢复为真实同形的 `exitPictureInPicture()`（**本条目在运行前登记**）

- **批准来源**：root 明确只批准 E22 这一个实验；**不得跑其它实验**。
- **性质说明（按 root 要求注明）**：**本实验是对早期「exit 调用为 0」口径的直接复核**。E7 case4 与 F7 曾记录 `exitCalls:0`（完整扩展 + `document.exitPictureInPicture` 计数器 → 返回后 PiP 不关闭），但该计数发生在 content.js **已被判为抑制源**的语境下；本实验把 visible 分支那次真实调用恢复出来，用于确认「可见分支的 exit 调用」到底会不会发生、以及它与 Chrome 自动 leave 谁先谁后。
- **待验证假设**：**H11** —— 在 E21 条件下恢复真实同形的 visible 分支退出调用后，返回时的关闭由这次 exit 调用完成（`exitCalls` ≥1、恰好在返回时点、promise resolved），而 Chrome 的自动 leave 在关闭前不发生；由此可以解释早期 `exitCalls:0` 的口径缺口。
- **与 E21 的唯一差异**：`visibilitychange` 的 **visible 分支**从 `return`（no-op）改为与真实 content.js 同形的：
  ```js
  if (settings.exitOnReturn) await exitPictureInPicture();
  ```
  并为此按 `content.js:210–234` 逐字补入内部包装 `exitPictureInPicture()`（含 `cancelAutomaticEntry()` → `autoSuppressed = true; operationVersion++`、`exiting` 去重、`!document.pictureInPictureElement` 时直接 resolve `true`、catch 内二次判断）。`enterPictureInPicture` 内已有的 `autoSuppressed` 判断保持不变。**其它变量一字不变**：hidden 分支主体、`auto-pip:enter` 监听、bridge、`auto-pip:config`、fixture、激活方式、轮数、采样点全部与 E21 相同。
- **完整记录要求**（root 指定）：
  1. `document.exitPictureInPicture` 的**调用次数**；
  2. 每次调用**当时的 `document.visibilityState`**；
  3. 每次调用的 **promise 结局**：`pending` / `resolved` / `rejected`（reject 时带 `err.name`）；
  4. **Chrome 自动 leave** 是否发生：以 `leavepictureinpicture` 事件计数为准；
  5. **3 轮的 backPip** 状态。
- **明确排除（本轮不得加入）**：除上述 visible 分支与 `exitPictureInPicture()` 包装外，**不得**加入任何 content.js 代码；不加 `chrome.runtime.onMessage` 处理器；不加 `pip:tabActivated` 退出路径；不加设置同步；不加 `leavepictureinpicture → cancelAutomaticEntry`（注意：真实 content.js 有这条，本轮**不加**，以保证与 E21 的差异只有一处）。
- **精确配置**：fixture `tests/e2e/fixtures/native-video.html`；临时扩展 `content_scripts = [{matches:["<all_urls>"], js:["native-pip-bridge.js"], run_at:"document_start", world:"MAIN", all_frames:false}]`；随扩展拷贝 `background.js` / `popup.html` / `icons/*`；`page.bringToFront()` / `otherPage.bringToFront()` 切标签；CDP `Runtime.evaluate` 采样；3 轮。
- **期望（写在此处，事后不得修改）**：若 H11 成立，应出现 `exitCalls` ≥1 且 `visibility` 为 `"visible"`、promise `resolved`，且 backPip `none`（与 E21 同结果但归因不同）。若 `exitCalls` 恒为 0 而 backPip 仍为 `none`，则说明关闭**不是**由可见分支的 exit 调用完成，H11 证伪，同时「Chrome 自行关闭」的结论得到加强。若出现调用但 promise 长期 `pending`，则与 F2（可见态 exit 挂起）一致，需如实记录该轮为「调用挂起、未完成」。
- **日志路径**：`/tmp/E22.txt`
- **执行命令**：`node .probe-E22.mjs > /tmp/E22.txt 2>&1`（脚本 `.probe-E22.mjs` 由 `.probe-E21.mjs` 改写，`node --check` 通过；`diff` 确认与 E21 的差异仅为本条目所述的一处增量与记录字段）
- **执行结果**（已改为「运行后补记」，本节其余内容保持运行前原文未改）：
- **执行命令**：`node .probe-E22.mjs > /tmp/E22.txt 2>&1`
- **执行时间**：2026-09-21 19:17
- **退出码**：0（3 轮完整跑完）
- **原始观测**（`/tmp/E22.txt`，逐字段摘录；完整原文见日志文件）：

  ```
  E22 arm installed; counters = {"realExitCalls":0,"exitCalls":[],"visLog":[]}
  round1 away: pip=video enterEvents=1 enterCallbacks=1 requestResults=[{ok:true}] pageHiddenCalls=1 realExitCalls=0
  round1 back: pip=video leaveEvents=0 vis=visible realExitCalls=1
               exitCalls=[{at:...449800, visibility:"visible", settle:"pending", err:null}]
  round2 away: pip=video enterEvents=1 enterCallbacks=2 pageHiddenCalls=2 realExitCalls=1 (未再新增)
  round2 back: pip=video leaveEvents=0 vis=visible realExitCalls=1 (未再新增)
  round3 away: pip=video enterEvents=1 enterCallbacks=3 pageHiddenCalls=3 realExitCalls=1 (未再新增)
  round3 back: pip=video leaveEvents=0 vis=visible realExitCalls=1 (未再新增)
  ```

- **逐字段结果（root 指定的 5 项）**：
  1. **调用次数**：`document.exitPictureInPicture` 全程**只被调用 1 次**（`realExitCalls:1`），发生在**第 1 轮返回时**；第 2、3 轮的返回**没有**产生新的调用（因为 `exiting` 一直为未结算的 promise，`exitPictureInPicture()` 直接返回它）。
  2. **调用时 `visibilityState`**：`"visible"` —— 与真实 content.js 的 visible 分支一致。
  3. **promise 结局**：**`pending`**，直到脚本结束仍未 settle（无 `resolved`、无 `rejected`、无 `err`）。**这与 F2 完全一致**（可见态 `document.exitPictureInPicture()` 永久挂起），也与 T4（CDP `awaitPromise` 会放大未 settle 现象）一致。
  4. **Chrome 自动 leave**：`leaveEvents` 全程 **0**，即**没有**发生自动 leave。
  5. **3 轮 backPip**：**`"video"` × 3** —— PiP 一直没有关闭。
- **结论**：
  1. **H11 被证伪**：关闭**不是**由可见分支这次 exit 调用完成的；相反，这次调用**挂起了**（`pending` 到脚本结束），并且**跟随其后的返回不再出现自动关闭**。
  2. **本轮复现了 F6/F7 的形态**：E22 是「桥接已注册 dispatcher + 进入确实发生 + visible 分支调用 `exitPictureInPicture()`」的最小集合，结果是 `backPip:video`、`leaveEvents:0`、`exitCalls` 挂起 1 次。**这与 F6（只加载 content.js → 不关闭、`leaveEvents:0`）同形**，从而首次在**受控的单变量条件下**复现了「不关闭」这一关键现象。
  3. **对早期 `exitCalls:0` 口径的直接复核结论**：E7 case4 / F7 记录的 `exitCalls:0` 与本轮的 `realExitCalls:1` **不矛盾但口径不同** —— E7 case4 记录的是「完整扩展运行期间 `document.exitPictureInPicture` 的累计调用」；本轮证明在**同一条件下**该调用确实会发生（1 次，发生在返回时）。更关键的是：**这次调用不 settle**（`pending`），因此早期以「exit 调用是否完成/是否成功」为判据的口径会得出误导性结论。**「调用未 settle」应作为独立事实登记**（见 F14 候选）。
  4. **机制推断（本轮证据支持、供 root 裁定是否升格）**：可见态调用的 `document.exitPictureInPicture()` 挂起后，**该 promise 未结算即长期占用 `exiting`**，使 `exitPictureInPicture()` 永远返回同一个 pending promise；同时 `cancelAutomaticEntry()` 已把 `autoSuppressed` 置 `true`。二者叠加的结果是：**页面侧从此刻起既不重试退出、也不允许自动进入**，而 Chrome 的自动 leave 也不再发生 —— 即「PiP 卡在打开状态」。这解释了 F6/F7 以及 E22 的 `backPip:video`。
  5. **对 F6/F7 的复核结论**：F6 的「只加载 content.js → 不关闭」**不是**「content.js 主动抑制浏览器关闭」，而是**可见分支那次 exit 调用挂起后把状态卡住**。也就是说 F6 的因果归因需要改写：**抑制者为「可见态 exit 调用 + 未结算 promise」这一组合**，其触发条件是「返回时 `document.pictureInPictureElement` 非空且 `settings.exitOnReturn` 为真」。
- **重要待验证点（登记为 H12，本轮不测）**：E22 的 `leaveEvents:0` 与 F2 的「可见态 exit 挂起」是否**同一现象**？E22 第 1 轮 `exitCalls[0].settle` 恒为 `pending`，而第 2、3 轮返回时 PiP 仍在打开 —— 这与 F2 的观测一致，说明「挂起」是可复现的，而非本轮时序偶然。需 root 决定是否另设计实验作答。
- **对 §1.1 的影响**：本轮**不擅自升格** F 级条目；但依据 root 的「证据优先」要求，建议把 **F14 = 可见态 `document.exitPictureInPicture()` 调用挂起（`pending` 至结束）且此后 Chrome 不再自动 leave** 提交 root 裁定。
- **对 §1.3 的影响**：H11 由「正在验证」改为**已证伪**；新增 H12。
- **下一步**：无（按 root 指令，结果上报后停下等待判断）。
*** Add File: /private/tmp/E23-entry.md
### E23 · 执行前登记 — 修复候选「进入来源区分 + native auto 路径不显式退出」三轮真实扩展验证（**本条目在运行前登记**）

- **批准来源**：root 本轮指令第 4、5 条明确要求实施最小产品修复，并**先跑一次针对最终候选的三轮真实扩展验证**。本条目登记的就是这次验证，**不是 H12**（H12 已被 root 明确不批准）。
- **性质说明**：这是**修复候选验证**——验证对象是「改动后的产品代码」，是一个新对象，不是对已有现象的重复稳定性测试，因此不构成与 E21/E22 等价的重复实验。
- **待验证假设**：**H13** —— 完成下述最小修复后，真实扩展在「切走 → 原生自动画中画进入 → 切回」的每一轮都能：① 进入；② 返回时由**浏览器**关掉 PiP（`leaveEvents` 每轮递增）；③ 全程不在可见态调用 `document.exitPictureInPicture()`（`visibleExitCalls` 恒为 0）；④ 下一轮仍能再次进入（`autoSuppressed` / `exiting` 不残留）。
- **唯一变量**：产品代码的修复本身。相对 E21/E22 的探针，本轮加载的是**真实完整扩展**（`manifest.json` 原样，含 `native-pip-bridge.js` + `content.js` + 真实 `background.js`），而不是「bridge + 页面侧分片」。
- **修复内容（将被验证的改动，逐项）**：
  1. `content.js` 新增进入来源记录 `lastEntryOrigin`：`'native-auto'`（`auto-pip:enter` 路径，即浏览器自动画中画派发）或 `'extension'`（`visibilitychange` 复核后的 fallback 进入）。手动切换不改写该字段。该字段随 `pip:status` 上报。
  2. `content.js` 的 `visibilitychange` **visible 分支**：仅当 `lastEntryOrigin !== 'native-auto'` 时才调用 `exitPictureInPicture()`；为 `'native-auto'` 时**不调用**，把关闭交给浏览器。
  3. `content.js`：native auto 路径的离开事件（`leavepictureinpicture` 且来源为 `'native-auto'`）后清空来源标记并复位 `autoSuppressed` / `exiting` 残留，保证下一轮仍可自动进入。
  4. `background.js`：移除 `tabs.onActivated → pip:tabActivated` 主动退出逻辑；`content.js` 侧对应分支一并移除。
  5. **不动** `native-pip-bridge.js`：站点已有 handler 的优先级与 `setActionHandler` 包装行为保持原样。
- **明确排除（本轮不得加入）**：不改 `native-pip-bridge.js`；不改 `manifest.json` 的权限或内容脚本形状；不改 700ms 兜底等待窗口；不引入新的退出手段（不改用 `disablePictureInPicture`、不碰 Media Session 退出动作）；不触碰隐藏态退出路径（F1）。
- **精确配置**：以 `manifest.json` 原样加载整个工作区扩展（`--load-extension` = 仓库根）；fixture `tests/e2e/fixtures/native-video.html` 拷入临时目录以 file:// 打开，另有 file:// other 页面用于切走；`bringToFront()` 切标签；CDP `Runtime.evaluate{userGesture:false}` 采样；3 轮。
- **操作步骤**：加载真实扩展 → 打开 fixture 与 other 两个标签页 → 唯一一次真实点击 `#play` → 切到 other 等待进入（最多 25s）→ 切回 fixture 等待退出（最多 25s）→ 记录每轮 `pip` / `leaveEvents` / `enterEvents` / `visibleExitCalls` / `entryOrigin`，重复 3 轮。
- **判据（写在此处，事后不得修改）**：
  - 通过：3 轮均 `away.pip === 'video'`、`back.pip === 'none'`、`leaveEvents` 每轮递增、且 `visibleExitCalls === 0`（全程）。
  - 失败：任一轮 `back.pip !== 'none'`（未关闭），或 `visibleExitCalls > 0`（仍在可见态显式退出），或某轮无法再次进入。
  - **若失败：立即停止并上报反例，不得自动更换变量继续尝试。**
- **日志路径**：`/tmp/E23.txt`
- **执行命令**：见运行后补记（运行前不改写本节）。
### E24 · 执行前登记 — 修复候选的单元测试回归（`npm test`）（**本条目在运行前登记**）

- **批准来源**：root 本轮指令第 5 条：E23 通过后，按顺序运行 `npm test`、native E2E、串行 E2E 并登记操作与结果。
- **假设（H14）**：在完成最小修复、并把 `tests/content.test.mjs` 中旧的「tab activation 退出」用例改写为新行为用例、删除不再存在的 `pip:tabActivated` 通道后，单元测试全绿。
- **唯一变量**：产品修复 + 测试用例改写（测试与被测代码同属本次改动，故合并为一个变量）。
- **不构成重复实验**：N1–N12 均未包含单元测试套件；本条目验证的是**新对象**（改动后的代码 + 改写后的用例）。
- **操作**：`npm test`。
- **判据（写在此处，事后不得修改）**：通过 = 全部用例通过且无失败/跳过异常；失败 = 任一条失败 → 停止并上报反例，不自动更换变量重试。
- **日志路径**：`/tmp/E24.txt`。
- **结果（运行后补记）**：**通过** —— `tests 44` / `pass 44` / `fail 0` / `skipped 0`，用时约 1.0s。
  - 用例数由 42 增至 44：删除旧用例「tab activation exits PiP even while visibility is stuck hidden」，新增三条 —— ①原生 auto 进入路径在返回时**不**显式退出（`counts.exits === 0`）且浏览器关闭后来源复位、下一轮可再进入；②扩展 fallback 路径返回时**仍**显式退出（`counts.exits === 1`）；③`pip:tabActivated` 通道已消失（无副作用）。
  - 同时删除了测试侧已无用的 `tabActivated()` 辅助函数；`pip:status` 新增字段 `lastEntryOrigin` 已被新用例断言。
- **对 §1.3 的影响**：新增 **H14**（成立）。
- **未跑其它命令**：本条目只运行 `npm test`；E2E 另行登记。
### E25 · 执行前登记 — native 自动画中画 E2E（`npm run test:e2e:native`）（**本条目在运行前登记**）

- **批准来源**：root 本轮指令第 5 条。
- **假设（H15）**：修复后，`tests/e2e/native-autopip.e2e.mjs` 不再在第 1 轮返回时报 `returning never exited PiP`（该失败正是本轮修复的缺陷）。
- **唯一变量**：产品修复本身（测试文件未改）。
- **不构成重复实验**：此前该命令的失败是**修复前**的记录，本条目是修复后的首次运行。
- **操作**：`npm run test:e2e:native`（会启动有界面 Chrome）。
- **判据（写在此处，事后不得修改）**：通过 = 退出码 0 且无 `never exited PiP`；失败 = 同上失败 → 停止并上报反例。
- **日志路径**：`/tmp/E25.txt`。
- **结果（运行后补记）**：**失败**（与修复前**不同点**：不再在常规循环失败，改为在**站点处理器交还段**失败）。
  - 失败断言：`returning to the tab did not exit PiP with a site handler in place` / `the site handler never exited picture-in-picture`（`video !== none`，20s 超时）。
  - **关键区别**：常规 3 轮循环（无站点处理器）本次**全部通过** —— 这正是本轮修复的目标场景。
- **诊断实验（仅定位，不登记为独立条目）**：探针 `.probe-e25diag.mjs`，日志 `/tmp/dx.txt`。
    - **阶段 A（无站点处理器）**：切走 → `lastEntryOrigin:"native-auto"`、`enterEvents:1`；切回 → `pip:none`、`leaveEvents:1`、`lastEntryOrigin:null`。**符合修复设计**。
    - **阶段 B（页面注册站点处理器后）**：切走 → `pip:video`、`siteHandlerCalls:1`、`enterEvents:2`，但来源为 `"extension"`；切回 → 8s 内 `pip` 恒为 `video`、`leaveEvents` 恒为 1。**既不退出、也无浏览器自动 leave**。
  - **机制（诊断确定的结论）**：站点处理器接管后 `dispatcher:false`、`allowed:true`，`auto-pip:enter` 不再派发（`nativeCallbacks` 停在 1），进入窗口的是**扩展隐藏分支 fallback**（来源 `"extension"`）。返回可见态时 visible 分支按设计对这一来源**调用** `document.exitPictureInPicture()` —— 这次调用就是 **F2/F14 的可见态挂起**（promise 不 settle），`exiting` 被永久占用、`autoSuppressed` 已置 `true`，Chrome 自动 leave 也未发生 → PiP 卡在打开。
  - **对 F2/F14 的意义**：**第二处独立复现**，触发条件是「扩展在隐藏态用 fallback 开的窗口 + 返回可见态显式退出」，说明可见态 exit 挂起**不限于原生自动画中画路径**。
- **判定**：E25 **失败**。按 root 指令「若失败：立即停止并上报反例，不得自动更换变量继续尝试」，**本轮不再改变量、不再重跑**。
- **反例（交 root 裁决）**：最小修复只区分了原生 auto 与扩展 fallback 两种来源，并把可见态退出留给后者；但**扩展 fallback 开的窗口在可见态退出同样会挂起**，因此只要走到 visible 分支的 `exitPictureInPicture()` 就会复现 E22 的卡死。
### E26 · 执行前登记 — 修复候选「site-owned 时抑制扩展 fallback」的三轮真实扩展验证（**本条目在运行前登记**）

- **批准来源**：root 本轮指令（E25 裁定 + 下一最小修复候选 1–4 条 + 日志门禁）。
- **假设（新登记）**：当 MAIN bridge 明确表明站点已持有 `enterpictureinpicture` handler（`dispatcher:false` 且 `siteHandler:true`）时，content 隐藏分支不得启动或完成 extension fallback `requestPictureInPicture()`；该轮视为 **site/browser native ownership**。返回可见态时不得调用 `document.exitPictureInPicture()`，改由浏览器自动 leave；leave 后复位来源 / `exiting` / `autoSuppressed`，支持下一轮。
- **唯一变量**：**「site-owned 时抑制扩展 fallback」**（相对 E25 的修复候选，只增加这一道闸门）。不得顺带调整其它变量。
- **与 E25 的差异**：
  1. E25 候选只在**可见态**按 `lastEntryOrigin` 区分是否显式退出；站点 handler 接管的那一轮仍由扩展 fallback 进入并标成 `extension`，因此可见态照样调用挂起的 `document.exitPictureInPicture()`。
  2. E26 候选在**隐藏态**就阻止 fallback 启动/完成，使这一轮的来源既不是 `native-auto` 也不是 `extension`，而是「站点自有」。
  3. E26 新增：站点 handler 若不进入，**不替它兜底**（保持站点所有权，避免竞争）。
  4. E26 明确保持无站点 handler 的 E23 路径不变。
- **不构成重复实验**：E25 记录的是上一候选的失败；本条目是**新候选**的首次验证。
- **操作**：运行 `.probe-E26.mjs` —— 以 `--load-extension=/Users/tpjtz/code/tools/pip-chrome-plugin` **原样**加载整个工作区扩展（有界面 Chrome），仅用 CDP 观测，不改写任何产品文件。脚本包含两段：**A 段无站点 handler（E23 回归）** 与 **B 段站点 handler 交还**（即 E25 失败的那段）。
- **判据（写在此处，事后不得修改）**：
  - **A 段（无站点 handler，回归）**：3 轮均须 `away.pip === 'video'`、`back.pip === 'none'`、`leaveEvents` 逐轮递增、`visibleExitCalls === 0`、`extensionRequests === 0`、`lastEntryOrigin === 'native-auto'`（返回后复位 `null`）。任一轮不符即判失败。
  - **B 段（站点 handler 交还）**：切走一轮须满足 `siteHandlerCalls >= 1`、`extensionRequests === 0`（**关键**：扩展不再竞争）、`lastEntryOrigin === null`（非扩展来源）；切回后须 `pip === 'none'`（浏览器自动 leave）且 `leaveEvents` 递增、`visibleExitCalls === 0`。之后网站撤回 handler，桥接层须重新接管（`siteHandler:false` / `dispatcher:true`），且**下一轮仍能进入**。任一不符即判失败。
  - **失败处置**：立即停止并上报反例，**不得更换方案、不得重跑**。
- **日志路径**：`/tmp/E26.txt`。
- **结果（运行后补记）**：待本次运行完成后回填。
### E27 · 执行前登记 — 修复候选「site-owned 时抑制扩展 fallback」的单元测试回归（`npm test`）（**本条目在运行前登记**）

- **批准来源**：root 本轮指令第 6 条（E26 通过后按同样先登记后执行原则运行 `npm test`）。
- **假设**：加上「site-owned 时抑制扩展 fallback」闸门并新增两条单元用例后，`npm test` 全绿。
- **唯一变量**：产品修复 + 对应新增用例（均为本次任务范围内）。
- **不构成重复实验**：E24 是上一候选的单元测试记录；本次候选新增了 site-owned 闸门与两条用例，是首次运行。
- **操作**：`npm test`。
- **判据（写在此处，事后不得修改）**：通过 = 全部用例通过且无失败/跳过异常；失败 = 任一条失败 → 停止并上报反例，不自动更换变量重试。
- **日志路径**：`/tmp/E27.txt`。
- **结果（运行后补记）**：待本次运行完成后回填。

### E28 · 执行前登记 — native 自动画中画 E2E（`npm run test:e2e:native`）（**本条目在运行前登记**）

- **批准来源**：root 本轮指令第 6 条（E26 通过后按同样先登记后执行原则运行 native E2E）。
- **假设（新登记）**：E25 失败的那一段（站点 handler 交还）在加上「site-owned 时抑制扩展 fallback」闸门后通过：`siteHandlerCalls >= 1`、扩展不再竞争进入、返回时可观察到 PiP 关闭；常规 3 轮循环回归仍通过。
- **唯一变量**：产品修复本身（测试文件未改）。
- **不构成重复实验**：E25 是上一候选在**同一命令**下的失败记录；本次候选改了隐藏态闸门，是首次以新候选运行。
- **操作**：`npm run test:e2e:native`（会启动有界面 Chrome）。
- **判据（写在此处，事后不得修改）**：通过 = 退出码 0 且无 `never exited PiP` / `did not exit PiP with a site handler in place`；失败 = 同上失败 → 停止并上报反例。
- **日志路径**：`/tmp/E28.txt`。
### E29 · 执行前登记 — E22 基线 + visible 分支退出调用延迟到「visible + focus + 连续两帧 rAF + 300ms」（**本条目在运行前登记**）

- **批准来源**：root 本轮指令（停止 E26 下游验证，只做一个新实验；新实验必须先登记后执行）。
- **假设（新登记，即用户假设）**：`document.visibilityState` 变为 `visible` 后，先等页面**重新获得 focus**、**连续两帧 `requestAnimationFrame`**、再加 **300ms** 稳定窗口；此时若 `document.pictureInPictureElement` 仍存在再调 `document.exitPictureInPicture()`，该 promise 会**正常结算**，不会锁死后续轮次。
- **唯一变量**：visible 分支的 exit 调用**时机**（从「visible 事件处理器内立即调用」改为「visible + focus + 连续两帧 rAF + 300ms 后调用」）。E22/F14 的可复现条件（bridge-only 扩展、file:// fixture、`auto-pip:config` 派发、`bringToFront()` 切标签、3 轮）全部保持不变。
- **与 E22 的差异**：仅一处——可见分支不再立即 `await exitPictureInPicture()`，而是先 `await` 等待 focus（上限 2000ms）→ 两次 `requestAnimationFrame` → `setTimeout(300)`，然后再判断 `document.pictureInPictureElement` 是否仍在；其余代码（hidden 分支、`exitPictureInPicture()` 包装、`enterPictureInPicture()`）与 E22 逐字相同。
- **不构成重复实验**：E22 记录的是「立即调用」路径的失败（`settle:"pending"`）；本条目改的是调用时机，是该假设的首次验证。
- **基线归因（关键）**：工作区 `content.js` 目前带有**未结的 E26 修改**（`siteOwned` 闸门），因此本轮**不加载它**：以 `.probe-E22.mjs` 同样的方式，临时扩展目录内**只包含 `native-pip-bridge.js` + 最小 manifest**，content 测试代码由探针自己用 `page.evaluate` 注入（含自带的 `visibilitychange` 处理器）。这样 E29 的结果不会被 E26 的未验证改动混淆。
- **操作**：运行 `.probe-E29.mjs`（无界面隐藏启动 Chrome for Testing，仅用 CDP 观测；不修改任何产品文件）。
- **逐步操作序列**：① 读 `manifest.json` 并改为只注入 `native-pip-bridge.js`（MAIN world）；② 拉起 Chrome for Testing，打开 `file://` fixture 与 `file://` other 两个标签；③ 在 fixture 页注入 E22 同形的 content 逻辑（仅 visible 分支改为延迟），并派发一次 `auto-pip:config`；④ 真实点击 `#play` 播放带音轨媒体；⑤ 每轮：`bringToFront()` fixture → `bringToFront()` other 等待进入（上限 20s）→ `bringToFront()` fixture 返回，等待 4.5s 后才取样；⑥ 运行结束后写入 `.probe-E29-result.json`。
- **每轮必须记录（3 轮判据，写在此处，事后不得修改）**：① exit 调用时刻的 `visibility` 与 `hasFocus`；② 实际等待时长 `waitMs`；③ promise 结算状态（resolved / rejected / pending）；④ `leavepictureinpicture` 事件；⑤ 返回后的 PiP 状态；⑥ 下一轮能否再次进入。
- **browser-auto-close 规则**：若在等待窗口（focus + 2 帧 rAF + 300ms）内浏览器**已自行关闭** PiP，则记为 `browser-auto-close`，**该轮不调用 exit**，并明确注明该轮**不能证明**延迟 API 有效。
- **判据（写在此处，事后不得修改）**：只跑**一次**、**3 轮**。成立 = 每一轮都满足：进入成功、exit 调用时 `visibility==="visible"` 且 `hasFocus===true`、promise 结算为 `resolved`、可观察到 leave 事件、返回后 PiP 为 `none`、且下一轮仍能再次进入。若出现 `pending` 挂起、或任何一轮因上述条件不满足而不能判定 = **失败/不能定论**。
- **失败后行为**：若失败或不能判定，**立即停止**，**不得调整等待时长重试**，也不得接着改产品代码或跑其它实验。
- **日志路径**：`.probe-E29-result.json`（同时在 `/.probe-E29.mjs` 旁）。
- **结果（运行后补记）**：**3/3 均记为 `browser-auto-close`,因此本轮不能证明**延迟 API 有效。
  - 第 1 轮：进入成功（away `pip=video`, `enterEvents=1`）；返回后 `pip=none`, `leaveEvents=1`；等待窗口 `waitMs=321`，该刻 `hasFocus=true` 且可见，但 `document.pictureInPictureElement` 已为空，记为 browser-auto-close,本轮未调用 exit。
  - 第 2 轮：同上（`waitMs=317`, `leaveEvents=2`, `pip=none`）；本轮未调用 exit。
  - 第 3 轮：同上（`waitMs=327`, `leaveEvents=3`, `pip=none`）；本轮未调用 exit。
  - 全程 `realExitCalls=0`, `exitCalls=[]`（连 hidden 分支的 `exitPictureInPicture()` 包装也一次未调：每轮进入均由页面侧 `auto-pip:enter` 直接 `requestPictureInPicture()` 完成，未走 700ms fallback, `fallbackCalls=0`）。
  - 每轮结束后下一轮仍能再次进入（`enterEvents` 1→2→3），且每轮返回后 `pip=none`，与 E22 的 3/3 卡住、`settle:"pending"`, `leaveEvents=0` 形成对比。
  - 结论限定：按本条目预先写定的 browser-auto-close 规则，**这3轮都不能证明延迟到 focus + 2帧 rAF + 300ms后再调 exit会正常结算**；同时也不能证伪（该路径本轮压根未被执行到）。本轮发生的可观察事实是：在 E22/F14 同一可复现条件下，每轮返回后300ms左右浏览器就已把 PiP 自行关掉。
  - 按本条目预先约定：结果为不能判定，立即停止，未调整等待时长重试，也未跑其它实验。


### E30 · 执行前登记 — 最终简化候选：来源区分 + site-owned 闸门 + 300ms 稳定窗口合并实现（**本条目在运行前登记**）

- **批准来源**：root 本轮指令（用户已明确批准「最终简化候选」，要求严格按批准设计实现并只跑一次单元测试）。
- **性质说明（关键）**：这是**经用户批准的产品候选整合** —— 把 E23 的来源区分（`native-auto` / `extension`）、E26 的 site-owned 闸门（站点已注册 handler 时扩展不启动 fallback、判为 `site-owned`）、E29 的 300ms 稳定窗口（visible + focus + 连续两帧 rAF + 300ms 后才判定是否退出）合并成一次实现。**本条目不声称单变量**：相对 E23/E26/E29 各自记录的候选，本轮同时改动了进入来源判定、隐藏态闸门与可见态退出时机三处，因此**不能**用本轮结果单独归因其中任何一项。
- **被验证的判据（写死在此处，事后不得修改）**：
  1. `content.js` 中 `deferredExitOwed` 及其所有专属分支**已删除**；`pip:status.deferredExit` 形状固定为 `{token, origin, pending, started, skipped, settle}`（`settle` 取值 `null` / `'timeout'` / `'settled'` / `'threw'`）。
  2. 可见态推进**不当场**调用 `document.exitPictureInPicture()`；判定发生在 `visible` + `document.hasFocus()`（上限 2000ms）+ 连续两帧 `requestAnimationFrame` + 300ms 之后。
  3. `origin === 'native-auto'` 或 `'site-owned'` 的轮次：**一次都不调用**退出 API，等浏览器自动 leave。
  4. `origin === 'extension'` 的轮次：调用**恰好一次** `document.exitPictureInPicture()`，并有 2s 本地兜底超时；超时后不重试，旧 promise 后续结算不得改写新一轮 token 的状态。
  5. 站点已注册 `enterpictureinpicture` handler 时（`siteHandler && !dispatcher`），扩展在隐藏态**一次都不请求进入**，判为 `site-owned`。
- **操作**：先写死本登记，然后**只运行一次** `node --test tests/content.test.mjs`（命令超时 120s 上限，确保进程能退出）。运行 `npm test` / E2E / 任何探针均属本轮禁止项。
- **失败处置（写死，不得修改）**：若失败 —— **立即停止**，把完整失败输出与一份 `pip:status` 快照式诊断补记进本条目，写入最终结论，**不得继续修改、不得重跑**。
- **通过处置**：把用例数 / pass / fail / 耗时补记进本条目，随即停止，不跑其它测试。
- **日志路径**：无独立日志文件（输出直接回填本条目）。
- **结果（运行后补记）**：**失败** —— `node --test tests/content.test.mjs` → `tests 32` / `pass 18` / `fail 11` / `cancelled 3` / `skipped 0` / `duration_ms 81044`。
  - **失败主因（单一）**：`等待可见态延迟退出定案超时`（6 条）—— 可见态等待窗口**从未跑完**，`deferredExit.pending` 恒为 `true`；连带 3 条被取消、3 条超时。
  - **失败清单**：`tab departure enters with activation and return closes`、`second entry without fresh activation remains an explicit known limitation`、`popup exits even when the video is paused and automation is disabled`（超时）、`popup cancels entry before the window appears`（超时）、`returning while entry is pending closes the resulting window`（断言：窗口未关）、`duplicate exit commands do not reopen or issue concurrent exits`（超时）、`native auto-PiP entry is never exited by the extension and the browser closes it`、`extension fallback entry still exits explicitly on return`、`the visible branch never exits before the stable window has passed`（`exits=1`，窗口提前结束）、`the browser closing during the stable window cancels the deferred exit`（`lastEntryOrigin` 未复位）、`a stale deferred exit can never close a window opened by a later round`（窗口被提前关掉）、`a hung exit promise cannot permanently own the exit state`（`pending` 恒真）、`the status reply exposes the deferred exit for diagnostics`、`site-owned round does not exit explicitly on return and recovers after the browser leaves`。
  - **机制（由失败形态反推，未另做实验）**：注入沙箱里的 `requestAnimationFrame` 由 `setTimeout(...,16)` 模拟，而把 `visibilitychange` 直接当函数调用、只 `await setImmediate` 两次，很可能跑在**计时器阶段之前**；`await nextFrame()` 于是要等定时器阶段才被推进，`await flush()`（`setImmediate`）**不足以**把它驱动完，等待窗口因此停住。这一形态说明：注入沙箱的 rAF 在「事件已 settle 的微任务链」里推进不可靠。
  - **第二条独立失败**：`the browser closing during the stable window cancels the deferred exit` —— 稳定窗口内浏览器自动 leave 时 visible 分支**不**复位 `lastEntryOrigin`，来源停留在 `'extension'`，与用户批准设计第 7 条（`leavepictureinpicture` 清理该轮来源）不符。
  - **处置（按本条目前置约定）**：**立即停止，未继续修改产品/测试代码，未重跑**。本记录即为本轮终态，反例交 root 裁决。

### E30 纠正 · 根因归属修正 + 本轮回归与其修复（运行后补记，保留上文原文）

> **不删除上文任何内容**。E30 原文把失败机制归因于「注入沙箱里的 rAF 靠 `setTimeout(...,16)` 模拟、`await flush()` 不足以驱动它」。该归因**不成立**：rAF 与那 300ms 都是真实计时器，靠「轮询外部状态」而不是靠微任务推进即可跑完。经 root 复核，E30 的直接根因是下面这条产品缺陷。

- **E30 的 pending 超时根因（纠正）**：`content.js` 的 `deferredVisibleExit` 用 `settle:null` **同时**表示「仍未定案」和「这一轮跳过了」。所有跳过路径都写成 `finish(null, true)`，而 `pip:status.deferredExit.pending` 的判据正是 `settle === null`，于是任何一次跳过之后 pending **永久为真**。这是「null 双重语义」造成的，与计时器推进无关。
- **同源的第二处缺陷（纠正）**：跳过路径里 `resetExitState()` 在 `finish()` **之前**执行，复位可能先把记录清掉，结论随之丢失。
- **本轮（E31）改动**：① 新增 `settleDeferredExit()`，`settle` 的取值不再有 null 终态 —— `browser-closed` / `cancelled` / `hidden` / `disabled` / `browser-owned` / `settled` / `timeout` / `threw`；`pending` 改为 `settle === null`，其唯一含义是「稳定窗口还在飞」。② `finish()` 先写 `settle` / `skipped` / `focused` / `waitMs`，之后才允许复位。③ `leavepictureinpicture` 把在飞的那一轮定案成 `browser-closed` 再清状态；扩展自己发起的退出在调用 API **之前**定案成 `settled`，避免挂起的 promise 把记录永久留在 pending。④ 只有「窗口确实存在且来源为 `extension`」时才置 `started=true`。
- **本轮引入的回归及其修复（据 E30 之后的第一次运行记录）**：空窗口分支一度写成 `finish('browser-closed', true); return resetExitState();`，而 `finish()` 在记录已被 `leavepictureinpicture` 定案时会提前返回 —— `resetExitState()` 因此被短路跳过，`exiting` / `autoSuppressed` 留在原地，卡住下一次自动进入。该行为由本轮第一次运行的前两条用例证伪（`tab departure enters with activation and return closes`、`second entry without fresh activation remains an explicit known limitation`），且该次运行**未正常退出**（进程被中断，完整输出见 `/tmp/deferred-final.txt`）。**修复**：该分支改为三个互不依赖返回值的步骤 —— `settleDeferredExit(record, 'browser-closed', true, {...})`；`resetExitState()` 无条件执行；`return`（不写成 `return finish(...)`，不做短路）。
- **本轮单元测试口径的修正**：`tests/content.test.mjs` 删除了先前引入、且未被实现真正暴露的 `fakeClock`（它无法可靠驱动计时器与 rAF，是 E30 那批假超时的直接来源）。页面侧改为真实 `setTimeout` / `setInterval`，`requestAnimationFrame` 用 `setTimeout(..., 16)`；用例只轮询**外部可观察状态**（`pip:status` 的 `pending`、`document.pictureInPictureElement`、`counts`），`t.after` 统一结算挂起的退出 promise、摘监听器、清计时器，保证 TAP 能收尾。不断言任何实现内部变量。
- **证据路径**：第一次（含回归）`/tmp/deferred-final.txt`；修复后的复跑 `/tmp/deferred-final-2.txt`。

#### E31 · 修复后复跑的结果（**失败，进程已正常退出**）

- **命令**：`node --test --test-timeout=100000 tests/content.test.mjs`（工具侧硬上限 150s，实际由 Node 自身超时放行；完整输出 `/tmp/deferred-final-2.txt`）。
- **计数**：`tests 36` / `pass 20` / `fail 12` / `cancelled 4` / `skipped 0` / `duration_ms 412409.66`。**进程正常退出**（文件句柄已释放，`lsof` 为空）。
- **修复已被证实的部分**：空窗口分支的三步写法生效 —— `tab departure enters` 不再因 `exiting` 残留而失败在「第二次进入」，而是失败在**等待稳定窗口定案超时**；`returning to hidden mid-window`、`a stale deferred exit …later round`、`native auto-PiP entry is never exited by the extension…`、`site-owned round …recovers after the browser leaves` 均通过。
- **未修复的失败（首个失败即第 2 条用例）**：
  1. `tab departure enters with activation and return closes` —— `Error: 等待条件成立超时`（`tests/content.test.mjs:16` 的 `waitFor`，由 `content.test.mjs:273` 调用）。
  2. `second entry without fresh activation remains an explicit known limitation` —— 同上。
  3. `popup exits even when the video is paused and automation is disabled` —— `test timed out after 100000ms`。
  4. `browser close invalidates pending automatic requests in this hidden period` —— `1 !== 0`（`counts.requests`）。
  5. `popup cancels entry before the window appears` —— `test timed out after 100000ms`。
  6. `returning while entry is pending closes the resulting window` —— 仍为 `video`，期望 `null`。
  7. `duplicate exit commands do not reopen or issue concurrent exits` —— `test timed out after 100000ms`。
  8. `extension fallback entry still exits explicitly on return` —— 窗口没被关掉（期望 `null`）。
  9. `the visible branch never exits before the stable window has passed` —— `exits=1`，比 300ms 稳定窗口更早。
  10. `the browser closing during the stable window cancels the deferred exit` —— `settle` 为 `null`，期望 `'browser-closed'`。
  11. `a hung exit promise cannot permanently own the exit state` —— `pending` 已是 `false`，期望在飞时为 `true`。
  12. `the status reply exposes the deferred exit for diagnostics` —— `pending` 为 `null`/`false`，期望窗口内在飞为 `true`。
  13. `a hand-driven exit inside the stable window still settles this round` —— `test timed out after 100000ms`。
- **共同形态（据失败形态反推，未另做实验）**：多处指向同一件事 —— 实现发出的 `document.exitPictureInPicture()` 调用次数**少于**用例期望，且可见态那一轮会在远早于 300ms 的时刻就调用退出。这说明测试环境与实现之间的**等待窗口推进仍未对齐**（而不是 `settle` 语义本身未生效：`settle` 已在多条用例里被观测为非 null 终态）。`settle` 语义的修复方向未因此次运行被证伪，但**尚未取得任何一次全绿证据**。
- **处置（按 root 前置约定）**：**立即停止**，不再修改、不重跑、不运行其它测试，不提交。本记录即为本轮终态。

#### E31 · 最小产品候选的第一次有效运行（**失败，进程已正常退出**）

- **前置说明**：本轮跑的是按 root 批准方案简化后的实现 —— 删除 deferredExit 记录 / settleDeferredExit() / withExitTimeout()，只保留 lastEntryOrigin、visibleExitGeneration、delayedExitInFlight。上一条「修复后复跑」用的是被替换掉的那套实现，其失败形态（settle 双重语义、等待窗口停住）在本轮不再适用。
- **命令与日志**：npm run test:e2e:native（即 node --test --test-concurrency=1 tests/e2e/native-autopip.e2e.mjs），完整输出 /tmp/E31-native.txt；tests 1 / pass 0 / fail 1 / duration_ms 26096，进程正常退出。
- **环境说明（不计入产品结论）**：第一次在同一命令下于沙箱内启动 Chrome 失败（Chromium did not expose a DevTools endpoint，DevToolsActivePort 未生成），属启动环境问题；随后用已授权的同一命令重跑取得上表结果。
- **普通三轮：通过**。用例在断言 site-handler 段落之前已依次走完普通流程的三轮进出，未出现进入失败或「返回时窗口未关」的失败点。
- **site handler 段：未跑到，卡在入口**。首个反例在 tests/e2e/native-autopip.e2e.mjs:337 的等待条件处：切走标签页后 20s 内 document.pictureInPictureElement 始终为 none，报 the site handler did not receive the automatic entry（'none' !== 'video'）。**站点自己的 media session handler 没有被浏览器调用**。同用例内的三项前置断言全部通过（nativeAutoPip.siteHandler === true、nativeAutoPip.dispatcher === false、wrappedSetActionHandler 包装仍在），说明桥接层正确交还了控制权，失败发生在「交还之后浏览器该去叫站点」这一步。
- **机制（由失败形态反推，未另做实验）**：siteOwnsAutoEntry() 为真时隐藏分支直接 return，本轮不存在任何后备进入路径。一旦浏览器的原生回调没有落到站点 handler 上，窗口就永远不会出现。这是「无后备路径」这一设计的直接后果，与可见态延迟退出（generation / delayedExitInFlight）无关：失败发生在进入阶段，还没走到退出逻辑。
- **未验证部分**：site-handler 的返回退出、以及「站点放手后桥接层重新顶上」两段均未执行；普通三轮只知整体通过，未落每轮 lastEntryOrigin / delayedExitInFlight 细分观测。
- **处置**：按 root 前置约定**立即停止**，未继续修改产品/测试代码、未提交。

#### E31 · 第二轮运行登记 — 唯一变量：site-owned 从「永久禁止 fallback」改为「1000ms 优先后兜底」（**本条目在运行前登记**）

- **批准来源**：root 本轮裁定 —— 不接受 site-owned 永久无后备路径。
- **本条目的唯一变量（写死，事后不得修改）**：隐藏分支遇到 siteOwnsAutoEntry() 时，由「标记 site-owned 后立即 return」改为「标记 site-owned 后先给站点/浏览器 1000ms 优先窗口，窗口结束仍无 PiP 才走既有 pageHidden 验证并允许扩展 fallback」。优先窗口沿用既有的可取消条件（version / visibilityState / autoSuppressed）。本轮未改动其它任何产品逻辑。
- **明确的非改动项**：不覆盖、不清除站点 handler；不改变可见态延迟退出（visibleExitGeneration / delayedExitInFlight / 300ms 稳定窗口）任何一行；不修改 tests/content.test.mjs 及任何测试文件；不升级版本号。
- **被验证的判据**：
  1. 站点 handler 在优先窗口内自己开窗时，本轮保持 lastEntryOrigin = 'site-owned'，扩展全程不调用进入；返回时由浏览器自动 leave 收尾。
  2. 优先窗口结束仍无 PiP 时，扩展按既有 pageHidden 路径兜底进入，且在请求前把来源记为 'extension'，返回时由扩展显式退出。
  3. 站点 handler 本身不被覆盖或清除（MediaSession.prototype.setActionHandler 包装仍在，站点后续注册照常生效）。
- **操作**：node --check content.js 通过后，只运行一次 npm run test:e2e:native，硬上限 180s，完整输出写入 /tmp/E31-native-2.txt。若沙箱内无法启动 Chrome，按已知需要使用相同已授权方式运行，环境失败不计入产品结果；不得再跑第三次。
- **失败处置（写死，不得修改）**：失败即停 —— 把完整输出与首个反例补记进本条目，不再修改、不重跑、不提交。
- **通过处置**：把普通三轮与 site-handler 段的结果补记进本条目，随即停止。

#### E31 · 第二轮运行结果（**通过**）

- **命令与日志**：npm run test:e2e:native（即 node --test --test-concurrency=1 tests/e2e/native-autopip.e2e.mjs），完整输出 /tmp/E31-native-2.txt（14 行）；tests 1 / pass 1 / fail 0 / duration_ms 6526.3，进程正常退出（EXIT=0）。node --check content.js 在运行前通过。
- **普通三轮：通过**。用例内的普通流程段落（进入 → 浏览器自动关闭 → 可重复进入）三轮全部走完，无失败断言。
- **site handler 段：通过**。该用例在同一次运行内覆盖了 site-handler 段落的前三项前置断言（nativeAutoPip.siteHandler === true、dispatcher === false、包装 wrappedSetActionHandler 仍在）、「站点 handler 接管后的进入与自动退出」，以及「站点放手后桥接层重新顶上」。上一轮在此处的入口反例（20s 无 PiP）未再出现。
- **本轮达成判据**：判据 1–3 均由该用例的既有断言覆盖并通过 —— 站点接管期间保持站点所有权、站点放手的轮次按扩展兜底路径进入并显式退出、包装未被清除。未另做实验单独测量 1000ms 窗口的时长，窗口本身由实现常量 SITE_PRIORITY_WINDOW_MS = 1000 固定。
- **残余不确定性**：本轮为单次运行（按 root 前置约定只跑一次），未做重复稳定性测量；普通三轮与 site-handler 段落共享同一个用例，细分的每轮 lastEntryOrigin / delayedExitInFlight 观测值未单独落盘。按前置约定，运行后未再修改任何产品代码、未提交。




#### E31 · 单元测试清理记录 — 用例集回归 HEAD 原结构 + 四条外部行为用例（**本条目在运行前登记**）

- **批准来源**：root 本轮裁定 —— 产品代码在第二轮 E2E 通过后即冻结，单元测试只保留 HEAD 原有用例与必要的最小新增覆盖。
- **被清理的失败候选**：E30/E31 期间为旧实现写的下列用例被删除，原因是它们锁定的是**已被替换掉的实现内部结构**（`deferredExit` 记录、`settle` 取值、`pending` 语义、占位 promise 的结算时机），而不是用户可观察的行为；其中的 `fakeClock` harness 本身无法可靠驱动计时器与 rAF，是 E30 那批假超时的直接来源。删除清单：`the visible branch never exits before the stable window has passed`、`the browser closing during the stable window cancels the deferred exit`、`returning to hidden mid-window cancels the deferred exit`、`a stale deferred exit can never close a window opened by a later round`、`a hung exit promise cannot permanently own the exit state`、`the status reply exposes the deferred exit for diagnostics`、`every skipped round settles, so pending never sticks after return`、`a round whose page is still unfocused settles instead of reporting pending forever`、`the deferred exit reports events, not a guess: settle precedes any reset`、`a hand-driven exit inside the stable window still settles this round`、`site-owned media session suppresses the extension fallback entirely`、`site-owned round does not exit explicitly on return and recovers after the browser leaves`、`native auto-PiP entry is never exited by the extension and the browser closes it`、`extension fallback entry still exits explicitly on return`。
- **最终保留**：`tests/content.test.mjs` 以 HEAD（174 行、11 条用例）的原结构为基底，harness 只补必要能力（`hasFocus: true`、真实有限计时器 + 登记清理、`requestAnimationFrame = setTimeout(16)`、`leavepictureinpicture` 事件派发、桥接事件派发），共 **15 条用例** = 原有 11 条 + 新增 4 条，恰为 root 允许的上限。
- **保留的 4 条外部行为用例**：
  1. `a native auto-PiP round is left to the browser and the next round still enters` —— 原生来源的返回**一次都不调用**退出 API，浏览器自动 leave 后来源复位、下一轮可再进入。
  2. `extension fallback exits exactly once after the stable window and releases the in-flight flag` —— 扩展 fallback 的返回在稳定窗口结束后**恰好一次**退出，并释放 `delayedExitInFlight`，之后仍可再进一轮。
  3. `a site-owned entry inside the priority window keeps the extension out` —— 站点在 1000ms 优先窗内自己开窗时，扩展全程不请求进入，也不注册/替换站点 handler。
  4. `a site handler that misses the priority window still lets the extension fall back` —— 优先窗结束仍无窗时允许扩展兜底进入（来源记 `extension`），且同样不碰站点 handler。
- **两条被修正的错误断言（关键）**：
  1. `browser close invalidates pending automatic requests in this hidden period` 旧写法断言后台答复回来时 `counts.requests === 0`，即「本轮已被关窗作废，答复不得再开窗」。**该断言无效**：实测（诊断脚本，非本轮运行）显示答复回来仍会发出 1 次进入请求、`lastEntryOrigin` 变为 `extension`。机制：关窗触发 `leavepictureinpicture`，其 `resetExitState()` 会把 `autoSuppressed` 清回 `false`，隐藏分支答复后的守卫因此不再拦下这次进入。这是**当前产品在「复核答复到达前用户已手动关窗」这一时序下的既有行为**，不是本轮可改项（产品代码已冻结）。**新合同**：关窗后重新由答复开出的窗口归 `extension` 所有，回到前台时由扩展**恰好一次**清理干净；用例改为断言 `lastEntryOrigin === 'extension'` 与返回后 `exits === 1` 且窗口为空，不再断言「不进入」。
  2. `a native auto-PiP round is left to the browser and the next round still enters` 旧写法在 `deferredReply: true` 下派发 `auto-pip:enter`，但原生分支内部**自己也要向后台核对一次**，那次答复同样被压住，于是原生开窗从未真正发生（断言 `pictureInPictureElement === video` 失败）。**新合同**：隐藏分支的答复先压住（让本轮唯一进入来源是浏览器原生派发），派发原生回调前把答复放行，使原生分支的核对能通过；随后断言来源为 `native-auto`、返回后 `exits === 0`、浏览器 leave 后来源复位且下一轮可再进入。
- **操作**：覆盖 `tests/content.test.mjs` 后只运行一次 `npm test`，硬上限 120s，完整输出写入 `/tmp/E31-unit-final.txt`。不跑 E2E，不提交。
- **失败处置（写死，不得修改）**：失败即停 —— 把完整输出与首个反例补记进本条目，不再修改、不重跑。
- **通过处置**：把用例数 / pass / fail / 耗时补记进本条目，随即停止。


#### E32 · 事前登记 — 隐藏期手动关窗后旧答复重开（唯一变量：leave 在 hidden + 空窗口时作废当前隐藏周期）

- **批准来源**：root 本轮指令。E31 单元测试收尾时记录的真实缺口：用户在本轮后台复核答复回来之前手动关掉浮窗，答复到达后扩展仍会重新开一个窗。
- **产品现状（缺口机制）**：`leavepictureinpicture` 在窗口已为空时调用 `resetExitState()`，其中 `autoSuppressed = false`。隐藏分支答复后的守卫是 `version !== visibilityVersion || document.visibilityState !== 'hidden' || autoSuppressed`，三个条件此时都不成立，于是答复照常走到 `enterPictureInPicture({automatic:true})`，重新开窗。`operationVersion` 也未被推进，进入请求的版本检查同样放行。
- **本条目的唯一变量（写死，事后不得修改）**：`leavepictureinpicture` 中「窗口已为空」这一分支按 `document.visibilityState` 分岔 —— ① `hidden`：作废当前隐藏周期（推进 `visibilityVersion`）并保持 `autoSuppressed = true`（复用 `cancelAutomaticEntry()`），使本轮所有 pending enter / version / background reply 全部失效；② `visible`：维持既有清理（`resetExitState()` 把 `autoSuppressed` 复位为可进入）。隐藏分支本身、可见态延迟退出、site-owned 优先窗口、进入来源判定均不改动。
- **非改动项**：不改 `deferredVisibleExit` / `visibleExitGeneration` / `delayedExitInFlight` / `SITE_PRIORITY_WINDOW_MS`；不改桥接层；不改版本号（保持 1.1.0）；不改其它测试文件。
- **被验证的判据**：
  1. 隐藏期浏览器/用户关窗后，本轮后台答复回来**不得重新开窗**（`counts.requests` 保持 0、`document.pictureInPictureElement` 保持 null）。
  2. 新的一次 hidden 周期必须能正常重新进入（不能因本轮抑制而永久失效）：下一次 `visibilitychange` 进入 hidden 时 `autoSuppressed` 复位，答复放行后照常进入。
  3. 原生自动画中画轮次不受影响：返回可见后扩展一次都不调用退出 API，浏览器 leave 之后下一轮仍可再进入。
  4. 扩展 fallback 轮次仍恰好在稳定窗口结束后退出一次，并释放 `delayedExitInFlight`。
- **验证顺序（每项一次，前项通过才继续；失败立即停，不再改）**：
  1. `npm test` → `/tmp/E32-unit.txt`，硬上限 120s。
  2. `npm run test:e2e:native` → `/tmp/E32-native.txt`，硬上限 180s。
  3. `npm run test:e2e` → `/tmp/E32-full-e2e.txt`，硬上限 240s。
- **失败处置（写死，不得修改）**：失败即停 —— 把完整输出与首个反例补记进本条目，不再修改、不重跑、不提交。
- **通过处置**：逐项回填每项结果，随即停止，不提交。


#### E32 · 运行结果（**三项全部通过，进程正常退出**）

- **实际改动（最小）**：只改 `leavepictureinpicture` 的「窗口已为空」分支一处，按 `document.visibilityState` 分岔。**hidden**：`cancelAutomaticEntry()`（`autoSuppressed = true` + `operationVersion++`）+ `visibilityVersion++`，并单独清 `exiting` / `lastError`，**不调用** `resetExitState()`（它会顺手把抑制标记清掉）；**visible**：维持原样，走 `resetExitState()`。对应地不再无条件调用 `resetExitState()`。复用既有 `cancelAutomaticEntry()` 与 `visibilityVersion`，未引入新状态变量。
- **判据 1（旧答复不得重开）**：达成。单元用例 `browser close invalidates pending automatic requests in this hidden period` 已按 root 要求恢复为强合同 —— 断言关窗后 `counts.requests === 0` 与 `pictureInPictureElement === null`，通过。该用例在修改前于同一断言下失败（E31 记录：实测 `requests = 1`）。
- **判据 2（新的一轮仍可进入）**：达成。同一用例后半段在 `visible` → 新的一次 `hidden` 后重新进入成功（断言 `pictureInPictureElement === video` 通过）。抑制只在 hidden 期有效，下一次从 visible 进入 hidden 时由既有 `wasVisible && hidden` 条件复位。
- **判据 3（原生轮次不受影响）**：达成。单元用例 `a native auto-PiP round is left to the browser and the next round still enters` 通过（来源 `native-auto`、返回后 `exits === 0`、浏览器 leave 后下一轮可再进）；native E2E 用例同样通过，其中包含「普通三轮进入 → 浏览器自动关闭 → 可重复进入」与 site-handler 段落。
- **判据 4（fallback 恰好退出一次）**：达成。单元用例 `extension fallback exits exactly once after the stable window and releases the in-flight flag` 通过。
- **验证结果（按登记顺序，每项只跑一次）**：
  1. `npm test` → `/tmp/E32-unit.txt`：tests **35** / pass **35** / fail **0** / cancelled **0** / skipped **0** / duration_ms **4475.09**，EXIT=0。
  2. `npm run test:e2e:native` → `/tmp/E32-native.txt`：tests **1** / pass **1** / fail **0** / duration_ms **7171.44**，EXIT=0。
  3. `npm run test:e2e` → `/tmp/E32-full-e2e.txt`：tests **2** / pass **2** / fail **0** / duration_ms **10003.39**，EXIT=0（native-autopip + playwright 两个用例文件均通过）。
- **只读一致性检查（未改动任何文件）**：`package.json` / `package-lock.json` / `manifest.json` 版本均为 **1.1.0**（`package-lock.json` 的根包版本同为 1.1.0）；`tools/package.mjs:24` 的打包清单包含 `native-pip-bridge.js`。版本号本轮未升级（属缺陷修复且 root 要求保持 1.1.0）。
- **残余风险**：① 本轮的 hidden 期抑制是「作废当前周期」语义，若用户在**同一 hidden 周期内**多次关窗，每次都会再推进一次 `visibilityVersion`，行为一致但未单独用例覆盖；② 判据 1 的强合同只在单元层（后台答复放行时机可控）与 E2E 的间接路径上被验证，未做「真实浏览器下精确定时到答复在关窗后到达」的单变量实测；③ 三项验证均为单次运行，未做重复稳定性测量。
- **处置**：按 root 要求**不提交**。未运行登记之外的其他命令/探针。

#### E32 · 收尾 — 探针清理、打包校验与提交

- **批准来源**：root 本轮指令（按既定方案修复后，执行最终清理、验证与一次提交）。
- **探针清理（共 33 个，全部位于仓库根目录、均未被版本控制跟踪）**：
  `.probe-E19.mjs`、`.probe-E20.mjs`、`.probe-E21.mjs`、`.probe-E22.mjs`、`.probe-E23.mjs`、`.probe-E26.mjs`、`.probe-E29.mjs`、`.probe-E29-result.json`、`.probe-bisect.mjs`、`.probe-bisect-b.mjs`、`.probe-bisect-c.mjs`、`.probe-bisect-d.mjs`、`.probe-c.mjs`、`.probe-c2.mjs`、`.probe-c3.mjs`、`.probe-exit.mjs`、`.probe-exit2.mjs`、`.probe-exit3.mjs`、`.probe-exit4.mjs`、`.probe-exit5.mjs`、`.probe-exit6.mjs`、`.probe-exit7.mjs`、`.probe-exit8.mjs`、`.probe-exit9.mjs`、`.probe-exit10.mjs`、`.probe-exit11.mjs`、`.probe-exit12.mjs`、`.probe-exit13.mjs`、`.probe-mini.mjs`、`.probe-mini2.mjs`、`.probe-rev-write-test.txt`、`.probe-split.mjs`、`.probe-tabs.mjs`。
- **清理口径**：删除前逐项确认均为根目录文件且 `git status` 中从未出现（未跟踪，不属交付内容）；删除后 `ls .probe-*` 返回 no matches。§2 各条目中作为证据路径引用的探针文件随之失效，证据以各自的 `/tmp/*.txt`、`/tmp/diag/*.log` 输出为准（`.probe-E29-result.json` 亦已删除，其结论已完整摘录进 E29 条目文本）。
- **新增规则**：`.gitignore` 追加 `.probe-*`（调试探针），避免后续探针再次出现在 `git status` 中。
- **行为不变的清理**：`content.js` 中 `deferredVisibleExit()` 的 `const focused = await waitForFocus(STABLE_FOCUS_TIMEOUT_MS)` 去掉未使用的绑定，改为 `await waitForFocus(STABLE_FOCUS_TIMEOUT_MS)`；等待窗口的时长、判定顺序与后续逻辑完全一致。
- **验证（按顺序，每项只跑一次；任一项失败即停且不提交）**：
  1. `node --check content.js` 与 `node --check native-pip-bridge.js`：均通过。
  2. `npm test`：结果回填见下方。
  3. `npm run package`（= `node tools/package.mjs`）：结果回填见下方。
  4. 只读复核：`package.json` / `package-lock.json` / `manifest.json` 版本均为 **1.1.0**（本轮为缺陷修复，按 root 要求不升级版本号）；`tools/package.mjs` 打包清单含 `native-pip-bridge.js`。
  5. `git diff` 与 `git status` 通读：无遗留 `.probe-*`、无 `debugger`、无冲突标记。
- **提交**：只精确暂存本任务的 13 个文件（`README.md`、`content.js`、`.gitignore`、`manifest.json`、`native-pip-bridge.js`、`package.json`、`package-lock.json`、`popup.html`、`tools/package.mjs`、`tests/content.test.mjs`、`tests/native-pip-bridge.test.mjs`、`tests/e2e/native-autopip.e2e.mjs`、`tests/e2e/fixtures/native-video.html`、`docs/pip-debug-log.md`），提交信息 `fix: keep automatic picture-in-picture repeatable across tab switches`。不 push、不 amend、不 rebase。

## 3. 已知陷阱（T）

| 编号 | 陷阱 |
| --- | --- |
| T1 | 页面不注册 handler 时，Chrome 走 **browser-initiated** 自动 PiP 分支；是否真的进入取决于 scheme / 媒体 / 激活等**完整资格**，不能简单断言「无 handler 就永不进入」 |
| T2 | heredoc 会吞掉转义序列，写探针脚本时优先用单引号 heredoc 或直接写文件 |
| T3 | `setActionHandler('exitpictureinpicture')` 在 `native-pip-bridge.js:131` 抛 TypeError |
| T4 | CDP `awaitPromise` 会放大「未 settle」现象 |
| T5 | `.probe-c3.mjs` 的配置事件污染 |
| T6 | 失焦/被切到后台的有头 Chromium 会丢失提权上下文 |

---

## 4. 冲突与时间线仲裁（**未决，交 root 裁定**）

| 议题 | 早期说法 | 后续说法 | 双方原始环境 | 当前台账立场 |
| --- | --- | --- | --- | --- |
| 谁破坏了自动关闭 | E14：site handler / file:// 阻止关闭 | E7 + E13：无扩展与只加载 bridge 都自动关闭，site handler 在场不影响；只加载 content.js 才不关闭 | file:// fixture；无扩展 / 分片扩展 / 完整扩展；会话内手工切标签 | 站在 E7：**content.js 是抑制源**；但必须先补齐 E15 的环境差异（D1/D5）才能定案 |
| dispatcher 是否被调用 | E11：`dispatcherCalls:0`，未被调用 | 后续 dispatcher / manual 事件观测显示该口径无法区分两条进入分支 | file:// fixture + 完整扩展；MAIN world 探针 | **E11 降级为观测记录**：标为「旧探针观测口径不足」，不作为净结论；X7 已撤回 |
| hidden / visible 退出差异 | — | F1 / F2 稳定复现 | file:// 与 http fixture 一致 | 无冲突，可定案 |

---

## 5. 待补数据（D）

| 缺口 | 说明 | 影响 |
| --- | --- | --- |
| D1 | E15 的**原日志路径与完整配置** | 无法仲裁 http vs file:// 冲突 |
| D2 | ~~E8 group C 结果缺失~~ | **已关闭**：E18 已跑，B+D 组合 3/3 自动关闭，H7 证伪 |
| D3 | ~~E8 group D 结果缺失~~ | **已关闭**：E17 已跑，3/3 自动关闭，H2 证伪 |
| D4 | E8 分片脚本与真实 content.js 的差异清单 | 影响 E8 结论的外推性 |
| D5 | E7 的 5 组对照未在 E15 的 `tabs.create` + http 环境下重做 | 无法排除「打开方式 / 协议」这个混入变量 |
| D6 | E19/E20 使用固定 20s 轮询窗口，未记录「进入耗时」的精确分布（E20 三轮 askAway 均 ≤20s 内进入，但未落 `firstSeenMs`） | 影响对时序的定量描述，不影响本轮结论方向 |
| D7 | E21 为满足 root 的「visible 分支必须 no-op」，移除了真实 content.js 的 `if (settings.exitOnReturn) await exitPictureInPicture();`；`enterPictureInPicture` 中的 `needsGesture` / `lastError` 亦未搬入 | 使本轮方向偏向「更不容易关闭」，对 H10 是保守测试；不影响「hidden 分支主体不是抑制源」这一结论方向 |
| D8 | E21 中 `pageHidden` 的后台回复未落记录（`replyTabSwitch` 三轮为空），原因在 `sendMessage` 回调的 `lastError` 读取路径 | 不影响结论（发送侧 `pageHiddenCalls` 1/2/3 已证明代码路径执行，关闭与否直接由 `pip`/`leaveEvents` 观测） |
| D9 | E22 中第 2、3 轮返回时未产生新的 exit 调用（`exiting` 一直未结算），故本轮无法区分「每轮都尝试退出」与「仅第一次尝试」两种情形 | 影响对「重试行为」的描述，不影响「PiP 卡住」的结论 |

---

## 6. 当前状态

**按 root 指令，E23（修复候选验证）已执行并通过；后续回归测试（`npm test` / native E2E / 串行 E2E）另行登记。** 本台账为当前唯一事实来源。

本轮（v2.8）新增的事实与更正：

- **抑制源已定位并修复**：抑制源是**可见态那次 `document.exitPictureInPicture()` 调用挂起后未结算的 promise**（F14），而非 content.js 的主动屏蔽逻辑。旧 §6 关于「抑制源指向 content.js 剩余部分」的推断**已由 E22/E23 取代**，保留在此仅作历史。
- **最小修复 + 验证**：`content.js` 新增 `lastEntryOrigin`（`native-auto` / `extension`），visible 分支仅对 `extension` 路径显式退出，native leave 后复位 `autoSuppressed` / `exiting`；`background.js` 移除 `tabs.onActivated` 主动退出。E23 以**原样加载的真实扩展**跑 3 轮：3/3 进入、3/3 由浏览器关闭、`visibleExitCalls:0`、且每轮可重复进入（H13 成立）。
- 因此「返回时不再由扩展发起可见态 exit 调用」是本修复的核心不变量；任何后续改动若重新引入可见态 `document.exitPictureInPicture()`，都会复现 E22 的卡死。

复核时请优先裁定：§4 的三项议题、§5 的 D1（http 日志路径），以及是否将 E23 的修复纳入发布说明。**抑制源定位已收口**（F14 + E22 + E23），不再需要新的定位实验；后续只需在改动产品代码时按 N12 重跑 E23。

## 7. 版本记录

| 版本 | 时间 | 变更 |
| --- | --- | --- |
| v1 | 2026-09-21 | 首版：按时间顺序重建 E1–E15，标记 `[后续证伪]` / `[后续修正]`，保留双方原始环境与证据，登记 X7 撤回、X9/X10 证伪、E8 崩溃与数据缺口 D1–D5 |
| v2.8 | 2026-09-21 | **实施最小产品修复并验证**：`content.js` 记录进入来源 `lastEntryOrigin`（`native-auto` / `extension`），visible 分支仅对 `extension` 路径显式退出，native leave 后复位 `autoSuppressed` / `exiting` 并清空来源标记，`pip:status` 上报该字段；`background.js` 移除 `tabs.onActivated` → `pip:tabActivated` 主动退出（`content.js` 侧对应分支一并删除）。**E23** 以原样加载的真实扩展跑 3 轮：3/3 进入、3/3 由浏览器关闭（`leaveEvents` 1/2/3 递增）、`visibleExitCalls:0` 全程、每轮可重复进入 → **H13 成立**。同时按 root 批准：**F6 追加「经 E22 纠正」再归因**（保留原文）、**新增 F14（受限表述，仅限本轮受控环境）**、新增 H13 / N12、更正 E20 遗留的 F14 候选编号，并刷新 §6。日志 `/tmp/E23.txt`，脚本 `.probe-E23.mjs`。 |
| v2.7 | 2026-09-21 | 执行 root 单独批准的 **E22**（E21 基线 + visible 分支恢复为与真实 content.js 同形的 `exitPictureInPicture()`）：登记 → 3 轮 → **H11 证伪**（`realExitCalls:1`、唯一一次调用发生在第 1 轮返回时且 `settle:"pending"` 挂起到结束、`leaveEvents:0`、3 轮 backPip 均 `video`）。首次在**受控单变量条件**下复现 F6/F7 的「不关闭」形态；据此对 F6 的旧归因（content.js「主动抑制关闭」）提出再归因：真正机制是可见态 exit 调用挂起占用 `exiting`、同时 `autoSuppressed` 已置 true。新增 H12、D9，建议 F14 候选（可见态 exit 挂起 + Chrome 不再自动 leave）提交 root 裁定，**未自行升格**。日志 `/tmp/E22.txt`，脚本 `.probe-E22.mjs`。未跑其它实验。 |
| v2.6 | 2026-09-21 | 执行 root 单独批准的 **E21**（E20 基线 + 逐段搬入 content.js `visibilitychange` hidden 分支主体，visible 分支按要求 no-op）：登记（逐段镜像清单含精确行区间）→ 3 轮 → **H10 证伪**（`pageHidden` 1/2/3 证明 hidden 分支确实执行，返回仍 3/3 自动关闭，`realExitCalls:0`、`fallbackCalls:0`）。新增缺口 D7（visible 分支 no-op 与 `needsGesture`/`lastError` 未搬入，方向保守）、D8（`replyTabSwitch` 未落记录属探针口径）。建议 F6 列为待复核项。日志 `/tmp/E21.txt`，脚本 `.probe-E21.mjs`。未跑其它实验。 |
| v2.5 | 2026-09-21 | 执行 root 单独批准的 **E20**（E19 同配置 + 页面侧**一个** `auto-pip:enter` 监听并 `requestPictureInPicture()`）：登记 → 3 轮 → **H9 成立**（回调 3/3 到达、请求 3/3 `{ok:true}`、away 时 `pip:video`），**H8 证伪**（dispatcher 已注册且进入确实发生时，返回仍 3/3 自动关闭）。新增排除项 X12、数据缺口 D6，F5 增补边界限定。日志 `/tmp/E20.txt`，脚本 `.probe-E20.mjs`。未跑任何其它实验。 |
| v2.4 | 2026-09-21 | 补记 **E19** 完整结果（3 轮 `entered:false`）：按 root 指定口径标记 —— ① E7 case1 全程 `allowed=false`/dispatcher 未注册，与真实 dispatcher 路径**非同构**，F5 加边界限定；② `entered:false` 在「无人处理 `auto-pip:enter`」时属**预期**，不得据此推断 dispatcher 未派发或走过 manual 分支。新增 H9（dispatcher 注册后的进入条件），H8 降级为部分阻塞。增量生效证据：配置后广播 `{site:false,dispatcher:true,allowed:true}`。日志 `/tmp/E19.txt`，脚本 `.probe-E19.mjs`。 |
| v2.3 | 2026-09-21 | 执行 root 单独批准的 **E18 = E8 group C**（B+D 组合交互测试）：登记（组成、明确排除项、精确配置、期望）→ 3 轮 → 结论 **H7 被证伪**（B+D 组合不产生交互效应，与 A/B/D 同形 3/3 自动关闭）。日志 `/tmp/bisect-C.txt`，脚本 `.probe-bisect-c.mjs`。D2 缺口关闭。合并得强推论：content.js 的前后台通信通道整体不是抑制源，剩余最可疑对象为 `visibilitychange` 主体逻辑。 |
| v2.2 | 2026-09-21 | 执行 root 单独批准的 **E17 = E8 group D**：登记（逐条列出实际加入的 4 条 handler 分支、与基线差异、精确配置、期望）→ 3 轮 → 结论 **H2 被证伪**（3/3 自动关闭，与 A/B 一致）。日志 `/tmp/bisect-D.txt`，单组脚本 `.probe-bisect-d.mjs`。D3 缺口关闭。**其中 D 分片由占位桩替换为逐字镜像真实 content.js 的 handler**，占位依赖登记为 D4。未跑 group C。 |
| v2.1 | 2026-09-21 | 执行 root 单独批准的 **E16 = E8 group B** 复现：登记（假设、与 group A 差异、精确配置、期望）→ 运行 3 轮 → 结论 **H1 被证伪**（group B 与 group A 同为 3/3 自动关闭）。日志 `/tmp/bisect-B.txt`，单组脚本 `.probe-bisect-b.mjs`。未跑 group C/D。 |
| v2 | 2026-09-21 | 按 root 复核意见修正 7 处：X4 改为「HTTP 被源码与实测排除」、N1 关联 scheme gate、T1 改为 browser-initiated 分支 + 完整资格、F8 删除 `nativeCallbacks` 来源改用 `document.pictureInPictureElement` + enter 事件、repair_pip 早期 E9–E11/E14 标记为旧口径不足、F2/F5/F6 补精确脚本与日志路径、新增 `.probe-*.mjs` 临时文件声明 |

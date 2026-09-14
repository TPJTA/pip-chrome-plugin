# 自动画中画 · Auto PiP on Tab Switch

一个 Chrome 扩展（Manifest V3）：**视频正在播放时，只要你切到其他标签页，它就会自动浮窗（画中画）继续播放。**

## 它做了什么

| 你的操作 | 视频正在播放 | 视频已暂停 | 说明 |
| --- | --- | --- | --- |
| 切到**其他标签页** | ✅ 自动进入画中画 | ⬜ 不处理 | 核心行为 |
| 切回原标签页 | ⬜（可选择自动退出画中画） | ⬜ | 见「返回标签页时自动退出」 |
| 切到**其他应用**（⌘Tab / Alt+Tab） | ⬜ 不处理 | ⬜ 不处理 | 明确不触发 |
| 最小化浏览器窗口 | ⬜ 不处理 | ⬜ 不处理 | 不属于切标签页 |

「切标签页」和「切应用」的区分不是靠窗口焦点，而是靠**当前标签页是否还是所在窗口的活跃标签页**——切应用时活跃标签页不会变化，所以天然不会误触发。

## 安装

1. 打开 `chrome://extensions/`
2. 打开右上角的 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本目录（含 `manifest.json` 的那一层）
4. 建议把图标固定到工具栏，方便随时开关

> 需要 Chrome 116+（或任意支持 Manifest V3 与画中画 API 的 Chromium 浏览器）。
> 画中画在**无头 / 自动化浏览器**里不可用，请在正常窗口中测试。

## 控制面板

点击工具栏图标打开，三个开关都保存在 `chrome.storage.sync`（会跟随账号同步）：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| **切换标签页时进入画中画** | 开 | 总开关。关掉后完全不再自动浮窗 |
| **返回标签页时自动退出** | 开 | 回到该标签页时把视频收回页面内 |
| **兼容模式** | 关 | 个别页面首次切换不生效时开启，见下方「排查」 |

面板顶部还会实时显示当前标签页的状态（正在播放 / 已在画中画中 / 未检测到视频），底部按钮可手动进入或退出画中画。

界面预览（浅色 / 深色跟随系统）：

| 浅色 | 深色 |
| --- | --- |
| ![浅色](docs/preview-light.png) | ![深色](docs/preview-dark.png) |

## 工作原理

```
切换标签页
   │
   ├─ content.js  监听 visibilitychange → 页面变为 hidden
   │     ├─ 先看有没有「正在播放」的视频（暂停的不算）→ 没有就直接返回
   │     └─ 问后台：这次隐藏是不是切标签页？
   │
   ├─ background.js  查 chrome.tabs.query({active:true, windowId})
   │     ├─ 活跃标签页已换成别人 → 确认是切标签页 → 回 { tabSwitch: true }
   │     └─ 活跃标签页还是自己 → 只是窗口失焦/最小化 → 回 { tabSwitch: false }
   │
   └─ 得到 true → pickVideo() 挑出最值得浮窗的视频 → requestPictureInPicture()
```

挑视频时带一套打分逻辑（有声 +1000、时长越长加分、面积越大加分、在视口内加分），避免把背景动画、粒子效果、循环 banner 这类装饰性视频当成正片。

## 已知限制与排查

**1. 浏览器要求页面有过一次用户交互**
Chrome 的 `requestPictureInPicture()` 受用户手势限制（`NotAllowedError`）。通常你点过「播放」就已经满足；若某个页面是**完全自动播放、且你从未点过该页面**，首次切换可能不生效。两个办法：

- 在该页面上随便点一下（点击页面即可「解锁」），之后就能正常工作；
- 打开控制面板里的 **兼容模式**，下次你在页面上交互时会自动做一次「进入 + 立刻退出」的预热。

**2. 跨域 iframe 里的播放器**
如果播放器在 iframe 里且 iframe 没有授权 `allow="picture-in-picture"`，浏览器会直接禁止画中画——这属于页面自身的权限策略，扩展无法绕过。

**3. DRM 视频**
Netflix 等受 DRM 保护的内容可能拒绝进入画中画。

**4. 切换到另一个 Chrome 窗口**
本扩展把「切标签页」定义为**同一个窗口内换了活跃标签页**。若你把视频窗口完整地留在屏幕上、只是切到另一个 Chrome 窗口，不会触发。

## 文件结构

```
├── manifest.json         # MV3 清单：只申请 storage 权限 + 全站内容脚本
├── background.js         # Service Worker：判定「切标签页」还是「切应用」
├── content.js            # 内容脚本：找播放中的视频、进出画中画
├── popup.html/css/js     # 控制面板
├── icons/                # 16 / 32 / 48 / 128 图标
├── docs/                 # 控制面板预览图
├── package.json          # 构建脚本入口
├── build/                # 打包产物（已写入 .gitignore）
└── tools/
    ├── gen-icons.mjs     # 生成 icons/ 下的 PNG
    ├── package.mjs       # 打包成 zip
    └── lib/zip.mjs       # 手写 ZIP 写入器（仅用 node:zlib）
```

## 构建与打包

不需要 `npm install`——脚本只用 Node 标准库，克隆下来就能跑：

```bash
npm run icons     # 重新生成 icons/ 下的四个 PNG
npm run package   # 打包成 build/auto-pip-on-tab-switch-<version>.zip
npm run build     # 上面两步一起跑
```

打包走白名单（`tools/package.mjs` 里的 `INCLUDE`），只收进扩展运行时需要的文件，
README、docs、tools 都不会进包，产物可直接上传 Chrome 应用商店或解压分发。
若 `manifest.json` 引用了白名单里缺失的文件，打包会**报错退出**而不是产出一个坏包。
打包产物目录 `build/` 已写入 `.gitignore`。

排查问题时，可先在 `chrome://extensions/` 点扩展卡片上的刷新按钮，再重新加载出问题的页面。

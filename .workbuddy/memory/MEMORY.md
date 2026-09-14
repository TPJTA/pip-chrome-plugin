# 项目长期备忘 — pip-chrome-plugin

Chrome MV3 扩展「自动画中画」。视频播放中切标签页 → 自动画中画。

## 项目约定

- **统一用 JavaScript / Node，不要在项目里引入 Python**。即使是生成图标这类构建脚本也用 Node 写
  （`tools/gen-icons.mjs`，靠 `node:zlib` 手写 PNG 编码）。用户明确质疑过用 Python 生成图标的做法。
- **尽量零第三方依赖**。构建脚本用 Node 标准库即可，不引入 Pillow / canvas / archiver 之类。
  用户明确说过「可以依赖三方依赖，只要能打包」，所以第三方**允许**，但当前方案零依赖已够用，不必为此加 `npm install` 步骤。
- **构建脚本统一放 `tools/`**，通过 `package.json` 的 npm scripts 调用。当前：`npm run icons` / `npm run package` / `npm run build`，打包产物落在 `build/`（已 gitignore）。
- 代码注释与界面文案用简体中文。
- 运行环境：Node 用托管版本 `/Users/tpjtz/.workbuddy/binaries/node/versions/22.22.2-3/bin/node`。

## 结构

```
manifest.json      MV3 清单（仅 storage 权限 + <all_urls> 内容脚本，不申请 tabs）
background.js      Service Worker：判定切标签页 vs 切应用
content.js         内容脚本（all_frames）：找播放中视频、进出画中画
popup.{html,css,js}控制面板：三个开关 + 状态 + 手动切换
package.json       构建脚本入口（icons / package / build）
tools/gen-icons.mjs图标生成（零依赖）
tools/package.mjs  打包成 build/*.zip（白名单 + manifest 引用兜底校验）
tools/lib/zip.mjs  手写 ZIP 写入器 + CRC32（被 gen-icons 复用）
docs/              控制面板预览图（浅色 / 深色）
build/             打包产物，已 gitignore
```

## 技术要点（改动时别踩）

- 判定「切标签页」必须用 `chrome.tabs.query({active:true, windowId})` 比对活跃标签页是否易主，
  不能用 `document.hasFocus()`（切应用同样失焦）。
- `requestPictureInPicture()` 受用户手势限制；不要设 `video.autoPictureInPicture = true`
  （浏览器内置自动画中画在切应用时也会触发，违反需求）。
- 预览 popup 深色态：无头 Chrome 的 `--force-prefers-color-scheme=dark` 无效，需把
  popup.css 的 dark media query 抽出花括号单独成表再渲染。

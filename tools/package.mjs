#!/usr/bin/env node
/**
 * 把扩展打包成 build/ 下的 zip，可直接上传 Chrome 应用商店或解压分发。
 *
 *   npm run package
 *
 * 打进去的只有扩展运行时真正需要的文件（白名单见 INCLUDE），
 * README、docs、tools、package.json 都不会进包。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = path.join(ROOT, 'build');

/** 需要进包的内容（相对项目根目录，目录会被递归展开）。 */
const INCLUDE = [
  'manifest.json',
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons'
];

/* ------------------------------------------------------------------ 工具 -- */

function collectFiles(relative) {
  const absolute = path.join(ROOT, relative);
  if (fs.statSync(absolute).isFile()) return [relative];

  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => collectFiles(path.posix.join(relative, entry.name)));
}

/** 找出 manifest.json 里引用的所有本地文件，用于校验白名单没漏东西。 */
function manifestReferences(manifest) {
  const refs = new Set();
  const add = (value) => {
    if (typeof value === 'string') refs.add(value);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  Object.values(manifest.action?.default_icon ?? {}).forEach(add);
  Object.values(manifest.icons ?? {}).forEach(add);

  for (const script of manifest.content_scripts ?? []) {
    (script.js ?? []).forEach(add);
    (script.css ?? []).forEach(add);
  }
  return [...refs];
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/* ------------------------------------------------------------------ 打包 -- */

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const files = INCLUDE.flatMap(collectFiles).sort();

// 兜底：manifest 若引用了白名单里没有的文件，宁可报错也不要打出一个坏包
const missing = manifestReferences(manifest).filter((ref) => !files.includes(ref));
if (missing.length) {
  console.error('✗ manifest.json 引用了未打进包里的文件：');
  for (const file of missing) console.error(`    ${file}`);
  console.error('  请把它们加入 tools/package.mjs 的 INCLUDE 白名单。');
  process.exit(1);
}

const entries = files.map((name) => ({
  name,
  data: fs.readFileSync(path.join(ROOT, name))
}));

const archiveName = `${pkg.name}-${manifest.version}.zip`;
const archivePath = path.join(BUILD_DIR, archiveName);

fs.mkdirSync(BUILD_DIR, { recursive: true });
// 只清理历史压缩包，不动目录里其它东西
for (const existing of fs.readdirSync(BUILD_DIR)) {
  if (existing.endsWith('.zip') && existing !== archiveName) {
    fs.rmSync(path.join(BUILD_DIR, existing), { force: true });
  }
}

const zip = createZip(entries, { mtime: new Date() });
fs.writeFileSync(archivePath, zip);

/* ------------------------------------------------------------------ 输出 -- */

const rawTotal = entries.reduce((sum, entry) => sum + entry.data.length, 0);

console.log(`✓ 打包完成  build/${archiveName}  ${kb(zip.length)}（原始 ${kb(rawTotal)}）`);
console.log(`  共 ${entries.length} 个文件：`);
for (const entry of entries) {
  console.log(`    ${entry.name.padEnd(22)} ${kb(entry.data.length)}`);
}

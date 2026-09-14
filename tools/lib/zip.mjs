/**
 * 极简 ZIP 写入器 —— 只依赖 node:zlib，无需第三方库。
 *
 * 支持 store(0) 与 deflate(8) 两种方式，产出的是标准 ZIP，
 * 可被 `unzip`、macOS 归档工具、Chrome 应用商店正常读取。
 */

import zlib from 'node:zlib';

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const VERSION = 20; // 2.0 —— deflate 所需的最低版本
const UTF8_FLAG = 0x0800; // 文件名按 UTF-8 编码
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

/* ------------------------------------------------------------------ CRC32 -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），ZIP 与 PNG 共用。 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------ 时间戳转换 -- */

/** JS Date → DOS 时间/日期（ZIP 头使用 1980 纪元的 16 位格式）。 */
function toDosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, day };
}

/* ------------------------------------------------------------------ 打包 -- */

/**
 * @param {{ name: string, data: Buffer | Uint8Array | string }[]} entries
 * @param {{ mtime?: Date }} [options]
 * @returns {Buffer} 完整的 zip 内容
 */
export function createZip(entries, { mtime = new Date() } = {}) {
  const { time, day } = toDosDateTime(mtime);

  const localParts = [];
  const centralParts = [];
  let centralOffset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);

    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 已压缩过的内容（如图片）再 deflate 往往更大，此时退回 store
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度

    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    central.writeUInt16LE(VERSION, 4); // 创建者版本
    central.writeUInt16LE(VERSION, 6); // 解压所需版本
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(centralOffset, 42);

    centralParts.push(central, nameBuf);
    centralOffset += local.length + nameBuf.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录所在磁盘号
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

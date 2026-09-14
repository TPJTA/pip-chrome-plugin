#!/usr/bin/env node
/**
 * Generate the extension icons (16 / 32 / 48 / 128) as PNG files.
 *
 * Zero dependencies: shapes are rasterised by hand with 4x supersampling,
 * and the PNG container is assembled directly on top of node:zlib.
 *
 *   node tools/gen-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './lib/zip.mjs';

const OUT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'icons'
);

const SS = 4; // supersampling factor
const GRAD_TOP = [99, 102, 241]; // indigo-500
const GRAD_BOTTOM = [147, 51, 234]; // purple-600

/* ---------------------------------------------------------------- shapes -- */

/** Signed-distance test for a rounded rectangle. */
function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const qx = Math.max(x0 + r - px, px - (x1 - r), 0);
  const qy = Math.max(y0 + r - py, py - (y1 - r), 0);
  return qx * qx + qy * qy <= r * r;
}

/** Linear gradient sampled at a vertical position. */
function gradientAt(y, size) {
  const t = y / Math.max(1, size - 1);
  return [
    Math.round(GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t),
    Math.round(GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t),
    Math.round(GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t),
  ];
}

/**
 * Rasterise one icon at 4x and downsample. Returns RGBA bytes.
 */
function renderIcon(size) {
  const W = size * SS;
  const out = new Uint8Array(size * size * 4);

  // geometry, expressed in supersampled pixels
  const bgRadius = W * 0.23;

  const lw = Math.max(1, Math.round(W * 0.052));
  const sx0 = W * 0.185;
  const sy0 = W * 0.225;
  const sx1 = W * 0.815;
  const sy1 = W * 0.775;
  const screenRadius = W * 0.075;

  const insetW = (sx1 - sx0) * 0.5;
  const insetH = (sy1 - sy0) * 0.44;
  const gap = lw * 1.05;
  const ix0 = sx1 - insetW - gap;
  const iy0 = sy1 - insetH - gap;
  const ix1 = sx1 - gap;
  const iy1 = sy1 - gap;
  const insetRadius = W * 0.035;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // accumulate premultiplied colour over the SS*SS sub-samples
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;

          if (!inRoundRect(px, py, 0, 0, W, W, bgRadius)) continue; // transparent

          const ring =
            inRoundRect(px, py, sx0, sy0, sx1, sy1, screenRadius) &&
            !inRoundRect(
              px, py,
              sx0 + lw, sy0 + lw, sx1 - lw, sy1 - lw,
              Math.max(0, screenRadius - lw)
            );
          const inset = inRoundRect(px, py, ix0, iy0, ix1, iy1, insetRadius);

          let r, g, b;
          if (inset || ring) {
            r = g = b = 255; // white
          } else {
            [r, g, b] = gradientAt(py, W);
          }

          pr += r;
          pg += g;
          pb += b;
          pa += 255;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      if (pa === 0) continue; // fully transparent
      out[i] = Math.round(pr / samples);
      out[i + 1] = Math.round(pg / samples);
      out[i + 2] = Math.round(pb / samples);
      out[i + 3] = Math.round(pa / samples);
    }
  }

  return out;
}

/* ------------------------------------------------------------ PNG writer -- */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  // ihdr[10..12] = compression / filter / interlace = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ main -- */

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  const png = encodePng(size, size, renderIcon(size));
  fs.writeFileSync(file, png);
  console.log(`wrote ${path.relative(process.cwd(), file)}  ${png.length} bytes`);
}

// Generates build/icon.ico from scratch — no image libraries, no binary blob
// checked into the repo. The mark matches the app's title-bar badge: a rounded
// square with the same terracotta gradient.
//
//   node scripts/make-icon.mjs
//
// PNG and ICO are both written by hand here. An .ico is just a small header
// plus a run of images, and Windows has accepted PNG-encoded entries since
// Vista, so each size is emitted as a PNG and indexed.

import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
const SIZES = [256, 128, 64, 48, 32, 16];

// --- CRC32, for PNG chunks -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode raw RGBA pixels as a PNG. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 (None) keeps this simple
  // and the images are tiny, so the size cost is irrelevant.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- the mark --------------------------------------------------------------

const FROM = [217, 119, 87]; // #d97757
const TO = [184, 84, 58];    // #b8543a

/** Signed distance to a rounded square, used for antialiased edges. */
function roundedRectSdf(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - (halfW - radius);
  const qy = Math.abs(py) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/**
 * Antialiased coverage of the three-bar mark at one pixel, returned as the
 * white blend strength (0 = untouched tile, 1 = solid white).
 */
function barCoverage(x, y, size, ss) {
  const BARS = [
    { w: 0.50, y: 0.335, a: 1.00 },
    { w: 0.50, y: 0.500, a: 0.72 },
    { w: 0.30, y: 0.665, a: 0.44 },
  ];
  const h = size * 0.088;
  const r = h / 2;
  let best = 0;

  for (const bar of BARS) {
    const halfW = (size * bar.w) / 2;
    const cx = size / 2;
    const cy = size * bar.y;
    let cover = 0;
    for (let sy = 0; sy < ss; sy++) {
      for (let sx = 0; sx < ss; sx++) {
        const px = x + (sx + 0.5) / ss - cx;
        const py = y + (sy + 0.5) / ss - cy;
        if (roundedRectSdf(px, py, halfW, h / 2, r) <= 0) cover += 1;
      }
    }
    best = Math.max(best, (cover / (ss * ss)) * bar.a);
  }
  return best;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const pad = size * 0.055;            // a little breathing room in the tile
  const half = c - pad;
  const radius = size * 0.235;         // matches the 7px radius on a 26px badge
  const ss = size >= 64 ? 3 : 4;       // supersampling factor for clean edges

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cover = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - c;
          const py = y + (sy + 0.5) / ss - c;
          if (roundedRectSdf(px, py, half, half, radius) <= 0) cover += 1;
        }
      }
      const alpha = cover / (ss * ss);
      const i = (y * size + x) * 4;
      if (alpha <= 0) continue;

      // Gradient runs top-left to bottom-right, like the CSS 140deg badge.
      const t = Math.min(1, Math.max(0, (x * 0.45 + y * 0.55) / size));
      let r = FROM[0] + (TO[0] - FROM[0]) * t;
      let g = FROM[1] + (TO[1] - FROM[1]) * t;
      let b = FROM[2] + (TO[2] - FROM[2]) * t;

      // Three stacked bars, each fainter than the last: a list of sessions
      // being thinned out. Shrinking widths keep it readable at 16px, where
      // anything more detailed turns to mush.
      const bar = barCoverage(x, y, size, ss);
      if (bar > 0) {
        r += (255 - r) * bar;
        g += (255 - g) * bar;
        b += (255 - b) * bar;
      }

      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(b);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, rgba);
}

// --- ICO container ---------------------------------------------------------

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0;  // palette size
    e[3] = 0;  // reserved
    e.writeUInt16LE(1, 4);   // colour planes
    e.writeUInt16LE(32, 6);  // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

// --- run -------------------------------------------------------------------

await fs.mkdir(OUT_DIR, { recursive: true });

const images = SIZES.map((size) => ({ size, png: renderIcon(size) }));
const ico = buildIco(images);

await fs.writeFile(path.join(OUT_DIR, 'icon.ico'), ico);
await fs.writeFile(path.join(OUT_DIR, 'icon.png'), images[0].png);

console.log(`build/icon.ico  ${ico.length.toLocaleString()} bytes  (${SIZES.join(', ')})`);
console.log(`build/icon.png  ${images[0].png.length.toLocaleString()} bytes  (256x256)`);

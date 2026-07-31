/**
 * Dependency-free PNG icon generator (Fix Brief 1 #10). iOS home-screen icons
 * and Android maskable icons must be PNG — SVG is not honored. We have no image
 * tooling (sharp/ImageMagick) in this environment, so we rasterize the Stillpoint
 * mark procedurally and encode PNGs with Node's built-in zlib.
 *
 *   node scripts/gen-icons.mjs
 *
 * Emits public/icons/{icon-192,icon-512,icon-maskable,apple-touch-icon}.png.
 * The art mirrors public/icons/icon-192.svg: a deep indigo field with a warm
 * radial glow and three concentric rings around a tan center dot.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

// --- palette (sRGB) ---
const BG_TL = [0x1a, 0x1f, 0x3a];
const BG_MID = [0x2d, 0x1f, 0x4a];
const BG_BR = [0x1f, 0x2d, 0x4a];
const CREAM = [0xf4, 0xed, 0xe0];
const TAN = [0xd4, 0xa3, 0x73];

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function over(dst, src, alpha) {
  return [lerp(dst[0], src[0], alpha), lerp(dst[1], src[1], alpha), lerp(dst[2], src[2], alpha)];
}

/**
 * Render one RGBA buffer of `size`. `scale` shrinks the mark toward the centre
 * (maskable icons keep the mark inside a safe zone); `rounded` clips to a
 * rounded square (regular icons) vs a full bleed (maskable).
 */
function render(size, { scale = 1, rounded = true } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const R = (size / 512) * scale; // px per "design unit" (art drawn at 512)
  const corner = 112 * (size / 512);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // background diagonal gradient
      const d = (x + y) / (2 * size);
      let col = d < 0.5 ? mix(BG_TL, BG_MID, d * 2) : mix(BG_MID, BG_BR, (d - 0.5) * 2);
      // distance from centre in design units
      const dx = (x - c) / R;
      const dy = (y - c) / R;
      const dist = Math.hypot(dx, dy);
      // warm radial glow out to r=150
      if (dist < 150) {
        col = over(col, TAN, 0.35 * (1 - dist / 150));
      }
      // three rings + dot (stroke ~3 design units)
      const ring = (r, color, a) => {
        if (Math.abs(dist - r) < 2.0) col = over(col, color, a);
      };
      ring(150, CREAM, 0.3);
      ring(104, CREAM, 0.45);
      ring(58, TAN, 0.85);
      if (dist < 10) col = over(col, TAN, 1);

      // alpha: rounded-square clip for regular icons; full bleed for maskable
      let alpha = 255;
      if (rounded) {
        const rx = Math.min(x, size - 1 - x);
        const ry = Math.min(y, size - 1 - y);
        if (rx < corner && ry < corner) {
          const ddx = corner - rx;
          const ddy = corner - ry;
          if (Math.hypot(ddx, ddy) > corner) alpha = 0;
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(col[0]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[2]);
      buf[i + 3] = alpha;
    }
  }
  return buf;
}

// --- minimal PNG encoder (RGBA, no interlace) ---
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rows with filter byte 0 prepended
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync(OUT, { recursive: true });
const targets = [
  ['icon-192.png', 192, { rounded: true, scale: 1 }],
  ['icon-512.png', 512, { rounded: true, scale: 1 }],
  ['apple-touch-icon.png', 180, { rounded: true, scale: 1 }],
  // maskable: full bleed, mark pulled into the safe zone (~80%).
  ['icon-maskable.png', 512, { rounded: false, scale: 0.8 }],
];
for (const [name, size, opts] of targets) {
  writeFileSync(join(OUT, name), encodePng(size, render(size, opts)));
  console.log('wrote', name, `${size}x${size}`);
}

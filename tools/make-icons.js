/**
 * Generates icons/icon16.png, icon48.png and icon128.png.
 *
 * Placeholder artwork, drawn in code rather than committed as binary blobs so the
 * repo stays reviewable and the icons can be regenerated:
 *   node tools/make-icons.js
 *
 * A teal rounded square (Vinted's accent) with a white downward chevron, which reads
 * as both the "V" and a download arrow at 16px.
 *
 * Uses only node builtins — zlib for the pixel stream, a hand-rolled CRC-32 for the
 * chunk checksums.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Signed distance to a rounded rectangle, used for antialiased edges. */
function roundedRectDistance(x, y, size, radius) {
  const half = size / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Coverage of a chevron stroke at a point, 0..1. */
function chevronCoverage(x, y, size) {
  const s = size;
  const thickness = s * 0.14;
  // Two legs meeting at the bottom centre.
  const legs = [
    { ax: s * 0.28, ay: s * 0.34, bx: s * 0.5, by: s * 0.68 },
    { ax: s * 0.72, ay: s * 0.34, bx: s * 0.5, by: s * 0.68 },
  ];
  let best = Infinity;
  for (const leg of legs) {
    const vx = leg.bx - leg.ax;
    const vy = leg.by - leg.ay;
    const wx = x - leg.ax;
    const wy = y - leg.ay;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    const px = leg.ax + t * vx;
    const py = leg.ay + t * vy;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  // One pixel of feathering keeps small sizes from looking jagged.
  return Math.max(0, Math.min(1, (thickness / 2 - best) / 1 + 0.5));
}

function renderPng(size) {
  const bg = [9, 177, 186];
  const fg = [255, 255, 255];
  const radius = size * 0.22;

  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const outside = roundedRectDistance(cx, cy, size, radius);
      const alpha = Math.max(0, Math.min(1, 0.5 - outside));
      const mark = chevronCoverage(cx, cy, size);

      const r = Math.round(bg[0] + (fg[0] - bg[0]) * mark);
      const g = Math.round(bg[1] + (fg[1] - bg[1]) * mark);
      const b = Math.round(bg[2] + (fg[2] - bg[2]) * mark);

      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = Math.round(alpha * 255);
    }
    rows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, renderPng(size));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)}`);
}

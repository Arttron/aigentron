#!/usr/bin/env node
// Writes apps/extension/src/icons/{16,32,48,128}.png: a rounded square with a white "A" shape (pure Node, no image library).
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'src', 'icons');
mkdirSync(out, { recursive: true });

const inRoundRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// the "A": two legs and a bar, as thick lines in unit space
const seg = (x, y, x1, y1, x2, y2, w) => {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= w / 2;
};
const glyph = (x, y) => seg(x, y, 0.5, 0.2, 0.26, 0.8, 0.13) || seg(x, y, 0.5, 0.2, 0.74, 0.8, 0.13) || seg(x, y, 0.36, 0.6, 0.64, 0.6, 0.1);

function png(size) {
  const SS = 4; // supersampling
  const rows = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let a = 0, white = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
        if (inRoundRect(x, y, 0.22)) { a++; if (glyph(x, y)) white++; }
      }
      const n = SS * SS;
      const w = a ? white / a : 0;
      // background: a blue gradient top-left → bottom-right, the glyph white
      const t = (px + py) / (2 * size);
      const base = [Math.round(78 + 30 * t), Math.round(120 + 20 * t), 255];
      const o = 1 + px * 4;
      row[o] = Math.round(base[0] * (1 - w) + 255 * w);
      row[o + 1] = Math.round(base[1] * (1 - w) + 255 * w);
      row[o + 2] = Math.round(base[2] * (1 - w) + 255 * w);
      row[o + 3] = Math.round((a / n) * 255);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(join(out, `${s}.png`), png(s));
console.log('icons written to', out);

// 生成应用图标（无第三方依赖：手写 PNG 编码，zlib + CRC32）
// 输出 256x256（electron-builder 打包要求 ≥256）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZE = 256;

const px = new Uint8Array(SIZE * SIZE * 4);
const put = (x, y, [r, g, b, a = 255]) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  const na = a / 255;
  px[i] = Math.round(px[i] * (1 - na) + r * na);
  px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
  px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
  px[i + 3] = Math.max(px[i + 3], a);
};

const inRound = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
};

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 显示器外框 + 屏幕 + 底座（深灰）
    if (inRound(x, y, 24, 40, 228, 184, 24) && !inRound(x, y, 44, 60, 208, 164, 12)) put(x, y, [56, 62, 78]);
    if (inRound(x, y, 44, 60, 208, 164, 12)) put(x, y, [22, 26, 36]);
    if (y >= 200 && y <= 216 && Math.abs(x - 124) <= 12) put(x, y, [56, 62, 78]);
    if (y >= 216 && y <= 228 && x >= 72 && x <= 184) put(x, y, [56, 62, 78]);
  }
}
// 播放箭头（亮蓝三角）
for (let y = 80; y <= 168; y++) {
  for (let x = 88; x <= 184; x++) {
    const inside = x >= 104 && y >= 96 && y <= 152 && (168 - 104) * (y - 96) - (152 - 96) * (x - 104) >= 0;
    if (inside) put(x, y, [66, 170, 255]);
  }
}

// ---- PNG 编码（8-bit RGBA, filter 0） ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(here, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`[gen-icon] wrote assets/icon.png ${SIZE}x${SIZE} (${png.length} bytes)`);

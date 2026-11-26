import fs from 'node:fs';
import { deflateSync } from 'node:zlib';

// 外部部品を使わず、図形の被覆を4倍で計算して小さなアイコンも滑らかにする。
const directory = new URL('../docs/icons/', import.meta.url);
fs.mkdirSync(directory, { recursive: true });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4); return result;
}
function insideRound(x, y, l, t, r, b, radius) {
  if (x < l || x > r || y < t || y > b) return false;
  const cx = Math.max(l + radius, Math.min(r - radius, x)), cy = Math.max(t + radius, Math.min(b - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}
function color(x, y) {
  if (!insideRound(x, y, .025, .025, .975, .975, .18)) return [255, 255, 255, 0];
  const circle = (x - .5) ** 2 + (y - .37) ** 2 <= .26 ** 2;
  const triangle = y >= .38 && y <= .88 && Math.abs(x - .5) <= (.88 - y) * .5;
  let c = circle || triangle ? [255, 255, 255, 255] : [11, 87, 208, 255];
  if (insideRound(x, y, .32, .27, .68, .49, .035) || x > .4 && x < .5 && y > .235 && y < .285) c = [11, 87, 208, 255];
  if ((x - .5) ** 2 + (y - .38) ** 2 < .065 ** 2) c = [255, 255, 255, 255];
  return c;
}
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon.png', 32]]) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const pixel = color((x + (sx + .5) / 4) / size, (y + (sy + .5) / 4) / size);
        pixel.forEach((value, i) => { sum[i] += value; });
      }
      sum.forEach((value, i) => { raw[y * (size * 4 + 1) + 1 + x * 4 + i] = Math.round(value / 16); });
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  fs.writeFileSync(new URL(name, directory), png); console.log('作成：docs/icons/' + name);
}

// 复制 livekit-client UMD 构建产物到 renderer/vendor（免打包工具链）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = ['livekit-client.umd.min.js', 'livekit-client.umd.js'];
const nodeModules = path.join(here, '..', 'node_modules', 'livekit-client', 'dist');
const src = candidates.map((f) => path.join(nodeModules, f)).find((f) => fs.existsSync(f));
if (!src) {
  console.error(`[fetch-vendor] no livekit-client UMD found in ${nodeModules} — run npm install first`);
  process.exit(1);
}
const dstDir = path.join(here, '..', 'renderer', 'vendor');
const dst = path.join(dstDir, 'livekit-client.js');
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
const kb = Math.round(fs.statSync(dst).size / 1024);
console.log(`[fetch-vendor] livekit-client UMD -> renderer/vendor/livekit-client.js (${kb} KB)`);

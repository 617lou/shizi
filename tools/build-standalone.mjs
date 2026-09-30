// 生成单文件版：把 audio/ 里的语音内联进去，方便单独一个文件传到手机、
// 在豆包 / 微信里打开（这些环境里只有单个 html 时读不到同级目录的音频）。
// 用法：node tools/build-standalone.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'index.html');
const out = join(root, '识字游戏-单文件版.html');
const MARK = '<!-- VOICE_DATA 占位：tools/build-standalone.mjs 会把语音内联到这里，生成单文件版 -->';

let html = readFileSync(src, 'utf8');
if (!html.includes(MARK)) {
  console.error('index.html 里没找到 VOICE_DATA 占位注释，无法生成单文件版');
  process.exit(1);
}

const data = {};
let raw = 0;
for (const dir of ['zi', 'ph', 'ui']) {
  const full = join(root, 'audio', dir);
  for (const f of readdirSync(full)) {
    if (!f.endsWith('.mp3')) continue;
    const buf = readFileSync(join(full, f));
    raw += buf.length;
    data[`${dir}/${f.slice(0, -4)}`] = 'data:audio/mpeg;base64,' + buf.toString('base64');
  }
}

const keys = Object.keys(data);
if (keys.length === 0) {
  console.error('audio/ 里没有可内联的 mp3，先跑 python tools/gen-audio.py');
  process.exit(1);
}

html = html.replace(MARK, `<script>window.VOICE_DATA = ${JSON.stringify(data)};</script>`);
writeFileSync(out, html, 'utf8');

console.log(`内联 ${keys.length} 段语音（${(raw / 1024).toFixed(0)} KB）`);
console.log(`已生成 ${out}`);
console.log(`文件大小 ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB（原 index.html ${(Buffer.byteLength(readFileSync(src)) / 1024).toFixed(0)} KB）`);

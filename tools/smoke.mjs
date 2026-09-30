// 自检脚本：node tools/smoke.mjs
// 检查脚本语法、字表一致性、元素引用、语音文件是否齐全、单文件版是否是最新的
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'index.html');
const standalone = join(root, '识字游戏-单文件版.html');

let failed = 0;
const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => { failed++; console.log(`  \u2717 ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

const html = readFileSync(file, 'utf8');
console.log(`检查 ${file}\n`);

// 1. 取主脚本（含 var CHARS 的那个 script 块，单文件版里还有 VOICE_DATA 块）
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const script = blocks.find((s) => s.includes('var CHARS'));
if (!script) {
  bad('没找到含 var CHARS 的主脚本');
  process.exit(1);
}
try {
  new vm.Script(script, { filename: 'inline.js' });
  ok('内联脚本语法正确');
} catch (e) {
  bad(`内联脚本语法错误：${e.message}`);
}

// 2. 字表 / 关卡
const start = script.indexOf('var CHARS');
const end = script.indexOf('配置区结束');
let CHARS = null, LEVELS = null;
if (start < 0 || end < 0) {
  bad('没找到配置区');
} else {
  const block = script.slice(start, script.lastIndexOf('];', end) + 2);
  try {
    const s = vm.runInNewContext(`${block}\n;({ CHARS: CHARS, LEVELS: LEVELS })`, {});
    CHARS = s.CHARS; LEVELS = s.LEVELS;
    ok('配置区可以正常解析');
  } catch (e) {
    bad(`配置区解析失败：${e.message}`);
  }
}

const expectedKeys = new Set();
if (CHARS && LEVELS) {
  const all = Object.keys(CHARS);
  check(all.length >= 8, `字表共 ${all.length} 个字`);
  check(LEVELS.length >= 1, `共 ${LEVELS.length} 个关卡`);

  const missing = [], dup = new Map();
  for (const lv of LEVELS) {
    if (!Array.isArray(lv.chars) || lv.chars.length < 3) bad(`关卡「${lv.name}」字数不足 3 个`);
    if (!(lv.choices >= 2)) bad(`关卡「${lv.name}」choices 必须 >= 2`);
    if (lv.choices > all.length) bad(`关卡「${lv.name}」choices 超过字表总数`);
    if (!lv.color) bad(`关卡「${lv.name}」缺少 color`);
    for (const c of lv.chars) {
      if (!CHARS[c]) missing.push(c);
      dup.set(c, (dup.get(c) || 0) + 1);
    }
  }
  check(missing.length === 0, missing.length ? `关卡里有字表未定义的字：${missing.join(' ')}` : '每个关卡的字都在字表里');
  const repeated = [...dup].filter(([, n]) => n > 1).map(([c]) => c);
  check(repeated.length === 0, repeated.length ? `有字出现在多个关卡：${repeated.join(' ')}` : '没有字重复出现在多个关卡');

  const noId = all.filter((c) => !CHARS[c].id || !/^[a-z][a-z0-9]*$/.test(CHARS[c].id));
  const ids = all.map((c) => CHARS[c].id);
  const dupIds = ids.filter((x, i) => ids.indexOf(x) !== i);
  const noPy = all.filter((c) => !CHARS[c].pinyin);
  const noArt = all.filter((c) => !(CHARS[c].art || CHARS[c].stack));
  check(noId.length === 0, noId.length ? `id 缺失或不是小写字母：${noId.join(' ')}` : '每个字都有合法 id');
  check(dupIds.length === 0, dupIds.length ? `id 重复：${[...new Set(dupIds)].join(' ')}` : 'id 没有重复');
  check(noPy.length === 0, noPy.length ? `缺少拼音：${noPy.join(' ')}` : '每个字都有拼音');
  check(noArt.length === 0, noArt.length ? `缺少配图：${noArt.join(' ')}` : '每个字都有配图');

  for (const c of all) {
    expectedKeys.add(`zi/${CHARS[c].id}`);
    expectedKeys.add(`ph/right-${CHARS[c].id}`);
  }
  LEVELS.forEach((lv, i) => expectedKeys.add(`ui/lv${i + 1}`));
}

// 3. 脚本里直接引用的 ui/xxx 都要有对应音频（lv1..N 是拼出来的，单独算）
const uiLiterals = [...new Set([...script.matchAll(/'ui\/([a-z0-9-]+)'/g)].map((m) => m[1]))].filter((k) => k !== 'lv');
for (const k of uiLiterals) expectedKeys.add(`ui/${k}`);
check(uiLiterals.length > 0, `脚本里引用了 ${uiLiterals.length} 个界面语音（${uiLiterals.join('、')}）`);

// 4. 语音文件是否齐全
if (expectedKeys.size) {
  const missingAudio = [...expectedKeys].filter((k) => !existsSync(join(root, 'audio', `${k}.mp3`)));
  check(missingAudio.length === 0,
    missingAudio.length
      ? `缺 ${missingAudio.length} 个语音文件（跑 python tools/gen-audio.py）：${missingAudio.slice(0, 6).join(' ')}${missingAudio.length > 6 ? ' …' : ''}`
      : `${expectedKeys.size} 个语音文件都在（单字 + 短语 + 界面）`);
}

// 5. 单文件版是不是最新的
if (existsSync(standalone)) {
  const sh = readFileSync(standalone, 'utf8');
  const sameScript = sh.includes(script);
  check(sameScript, sameScript ? '单文件版里的游戏脚本与 index.html 一致' : '单文件版已过期：脚本不一致，重跑 node tools/build-standalone.mjs');
  const m = sh.match(/window\.VOICE_DATA = (\{[\s\S]*?\});<\/script>/);
  if (!m) {
    bad('单文件版里没找到内联的 VOICE_DATA');
  } else {
    try {
      const data = JSON.parse(m[1]);
      const lack = [...expectedKeys].filter((k) => !data[k]);
      check(lack.length === 0, lack.length ? `单文件版缺少内联语音：${lack.slice(0, 6).join(' ')}` : `单文件版内联了 ${Object.keys(data).length} 段语音，覆盖全部 ${expectedKeys.size} 个 key`);
      // 逐字节比对：光看 key 全不全，发现不了"音频重新生成过但单文件版还是旧语音"
      const mismatch = [];
      for (const k of expectedKeys) {
        const p = join(root, 'audio', `${k}.mp3`);
        if (!data[k] || !existsSync(p)) continue;
        const disk = createHash('sha1').update(readFileSync(p)).digest('hex');
        const inlined = createHash('sha1').update(Buffer.from(data[k].split(',')[1], 'base64')).digest('hex');
        if (disk !== inlined) mismatch.push(k);
      }
      check(mismatch.length === 0,
        mismatch.length
          ? `单文件版里的语音已过期（${mismatch.length} 段与 audio/ 不一致，跑 node tools/build-standalone.mjs）：${mismatch.slice(0, 4).join(' ')}`
          : `单文件版内联的 ${expectedKeys.size} 段语音与 audio/ 逐字节一致`);
    } catch (e) {
      bad('单文件版的 VOICE_DATA 不是合法 JSON：' + e.message);
    }
  }
} else {
  console.log('  · 还没生成单文件版（可选：node tools/build-standalone.mjs）');
}

// 6. 元素引用
const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]));
const refs = new Set([
  ...[...script.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]),
  ...[...script.matchAll(/getElementById\('([\w-]+)'\)/g)].map((m) => m[1])
]);
const dangling = [...refs].filter((id) => !ids.has(id));
check(dangling.length === 0, dangling.length ? `脚本引用了不存在的元素 id：${dangling.join(' ')}` : `脚本引用的 ${refs.size} 个元素 id 都存在`);

// 7. 自包含（index.html 只允许引用同目录的 audio/）
const external = [
  /<script[^>]+src=/i.test(html) && '<script src>',
  /<link\b[^>]*\bhref=/i.test(html) && '<link href>',
  /<img[^>]+src=["']https?:/i.test(html) && '外部图片',
  /@import/i.test(html) && '@import',
  /url\(["']?https?:/i.test(html) && '外部 url()'
].filter(Boolean);
check(external.length === 0, external.length ? `依赖了外部资源：${external.join('、')}` : 'index.html 没有外部资源依赖（只读同目录 audio/）');

// 8. 关键能力与约定
check(/speechSynthesis/.test(script), '保留 speechSynthesis 作为语音兜底');
check(/new Audio\(/.test(script), '优先播放生成的语音文件');
check(/tools\/gen-audio\.py/.test(html) || /tools\/gen-audio\.py/.test(script), '配置区提示了语音生成命令');
check(/maximum-scale=1/.test(html), '移动端 viewport 已禁止缩放');
check(html.includes('<!-- VOICE_DATA'), '保留了单文件版的内联占位注释');

console.log(failed === 0 ? '\n全部通过 \u2728' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);

// 声调体检：node tools/tone-check.mjs
// 逐个解码 audio/zi/*.mp3，量出音节内的基频走势和能量包络，用来判断：
//   - 三声有没有"先降后升"（升幅太小 = 尾巴听不出来，游戏里的语速可能要放慢）
//   - 四声降得够不够、末尾能量有没有提前衰减
// 语速是按声调分的（tools/gen-audio.py 里的 TONE_RATES），改完语速跑这个看效果。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9900;

// 从 index.html 取「字 → id / 拼音 / 声调」
const MARKS = { 1: 'āēīōūǖ', 2: 'áéíóúǘ', 3: 'ǎěǐǒǔǚ', 4: 'àèìòùǜ' };
const toneOf = (py) => Object.entries(MARKS).find(([, m]) => [...m].some((c) => py.includes(c)))?.[0] || '0';
const chars = [];
for (const m of readFileSync(path.join(root, 'index.html'), 'utf8')
  .matchAll(/'([^']+)':\s*\{\s*id:'([a-z]+)',\s*pinyin:'([^']*)'/g)) {
  chars.push({ ch: m[1], id: m[2], py: m[3], tone: toneOf(m[3]) });
}
if (!chars.length) { console.error('没能从 index.html 解析出字表'); process.exit(1); }

const ANALYZE = `
window.yin = function(frame, sr, fmin, fmax, thresh){
  const tauMin = Math.max(2, Math.round(sr / fmax));
  const tauMax = Math.min(frame.length - 2, Math.round(sr / fmin));
  if (tauMax <= tauMin) return null;
  const d = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++){
    let s = 0;
    for (let j = 0; j < frame.length - tau; j++){ const df = frame[j] - frame[j + tau]; s += df * df; }
    d[tau] = s;
  }
  const cmnd = new Float64Array(tauMax + 1);
  let run = 0;
  for (let tau = tauMin; tau <= tauMax; tau++){ run += d[tau]; cmnd[tau] = run > 0 ? d[tau] * (tau - tauMin + 1) / run : 1; }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++){
    if (cmnd[t] < thresh){ while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
  }
  if (tau < 0) return null;
  const x0 = tau > tauMin ? cmnd[tau - 1] : cmnd[tau];
  const x2 = tau < tauMax ? cmnd[tau + 1] : cmnd[tau];
  const denom = 2 * (2 * cmnd[tau] - x2 - x0);
  return sr / (tau + (denom !== 0 ? (x2 - x0) / denom : 0));
};
window.measure = async function(b64){
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(u8.buffer);
  const d = audio.getChannelData(0), sr = audio.sampleRate;
  const hop = Math.round(sr * 0.01);
  const env = [];
  for (let i = 0; i + hop <= d.length; i += hop){
    let s = 0;
    for (let j = i; j < i + hop; j++) s += d[j] * d[j];
    env.push(Math.sqrt(s / hop));
  }
  let vf = -1, vt = -1;
  for (let i = 0; i < env.length; i++){ if (env[i] > 0.02){ if (vf < 0) vf = i; vt = i; } }
  if (vf < 0){ await ctx.close(); return null; }
  const w = Math.round(sr * 0.04), h2 = Math.round(sr * 0.01);
  let series = [];
  for (let i = vf * hop; i + w <= (vt + 1) * hop; i += h2){
    const frame = d.subarray(i, i + w);
    let e = 0;
    for (let j = 0; j < w; j++) e += frame[j] * frame[j];
    if (Math.sqrt(e / w) < 0.03) continue;
    const f = window.yin(frame, sr, 70, 400, 0.18);
    if (f && f > 60 && f < 450) series.push([Math.round(i / sr * 1000), Math.round(f)]);
  }
  // 中值滤波 + 倍频修正（相邻点差一倍就拉回来）
  const med = series.map((p, i) => {
    const win = [series[i - 1], p, series[i + 1]].filter(Boolean).map((q) => q[1]).sort((a, b) => a - b);
    return [p[0], win[Math.floor(win.length / 2)]];
  });
  const f0 = [];
  for (const [t, v] of med){
    let f = v;
    if (f0.length){
      const r = f / f0[f0.length - 1][1];
      if (r > 0.42 && r < 0.58) f *= 2;
      else if (r > 1.7 && r < 2.4) f /= 2;
    }
    f0.push([t, Math.round(f)]);
  }
  const maxE = Math.max.apply(null, env.slice(vf, vt + 1));
  const tail = [];
  for (let k = 9; k < 12; k++){
    const a = vf + Math.round((vt - vf) * k / 12), b = vf + Math.round((vt - vf) * (k + 1) / 12);
    let m = 0;
    for (let j = a; j < Math.max(b, a + 1); j++) m = Math.max(m, env[j] || 0);
    tail.push(Math.round(m / (maxE || 1) * 10) / 10);
  }
  await ctx.close();
  return { from: (vf + 1) * 10, to: (vt + 1) * 10, f0: f0, tail: tail };
};
`;

let port = PORT;
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(os.tmpdir(), 'shizi-tone-check')}`, 'about:blank'], { stdio: 'ignore' });
let ws, msgId = 0;
const pending = new Map();
const send = (m, pr) => { const id = ++msgId; ws.send(JSON.stringify({ id, method: m, params: pr || {} })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

const TONE_NAME = { 1: '一声', 2: '二声', 3: '三声', 4: '四声', 0: '轻声' };
try {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(150);
    try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch (e) {}
  }
  if (!wsUrl) throw new Error('连不上无头 Chrome，检查 CHROME 环境变量');
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); } };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await evaluate(ANALYZE);

  console.log('声调体检（音色看 tools/gen-audio.py 的 DEFAULT_VOICE，语速看 TONE_RATES）\n');
  console.log('  字 声调  有声段      基频 起→最低→末     降   升    末尾能量   走势');
  const rows = [];
  let warns = 0, broke = 0;
  for (const { ch, id, tone, py } of chars) {
    const r = await evaluate(`window.measure(${JSON.stringify(readFileSync(path.join(root, 'audio', 'zi', id + '.mp3')).toString('base64'))})`);
    if (!r || !r.f0 || r.f0.length < 4) { broke++; console.log(`  ${ch} ${TONE_NAME[tone]}  ——  基频测不出来`); continue; }
    const vals = r.f0.map((p) => p[1]);
    const n1 = Math.max(1, Math.round(vals.length * 0.25)), n2 = Math.max(1, Math.round(vals.length * 0.2));
    const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
    const start = avg(vals.slice(0, n1)), end = avg(vals.slice(-n2)), min = Math.min(...vals);
    const rise = end - min;
    const span = r.to - r.from;
    const c = [];
    for (let k = 0; k < 6; k++) c.push(vals[Math.round((vals.length - 1) * k / 5)]);
    const warn = tone === '3' && rise < 10 ? '  ⚠ 三声升幅偏小，尾巴可能听不出来' : '';
    if (warn) warns++;
    console.log(`  ${ch} ${TONE_NAME[tone]}  ${String(r.from).padStart(4)}~${String(r.to).padStart(4)}ms(${String(span).padStart(3)}ms)  ${String(start).padStart(3)}→${String(min).padStart(3)}→${String(end).padStart(3)}Hz  ${String(start - min).padStart(3)}  ${String(rise).padStart(4)}  ${r.tail.join(' ')}   ${c.join('/')}${warn}`);
    rows.push({ tone, span, rise });
  }
  console.log('');
  for (const tone of ['1', '2', '3', '4']) {
    const g = rows.filter((r) => r.tone === tone);
    if (!g.length) continue;
    const avg = (k) => Math.round(g.reduce((s, r) => s + r[k], 0) / g.length);
    console.log(`  ${TONE_NAME[tone]}：${g.length} 个字，平均有声段 ${avg('span')}ms，平均升幅 ${avg('rise')}Hz`);
  }
  console.log(`\n${warns ? `有 ${warns} 个三声的升幅偏小` : '三声的"降-升"都在正常范围'}${broke ? `；${broke} 个测不出来` : ''}`);
} catch (e) {
  console.error('体检脚本出错:', e.message);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch (e) {}
  proc.kill();
}

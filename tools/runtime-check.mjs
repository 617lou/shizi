// 运行期校验：node tools/runtime-check.mjs
// 用无头 Chrome 真实跑一遍游戏，检查：
//   1) 每段语音能否解码，并量出"真正发音的结束点"（文件末尾自带约 0.6s 静音，光看时长会误判）
//   2) 跑完整关卡时每一段是否被下一段切尾（按发音结束点判定，不按文件总长）
//   3) 是否真的在读 audio/ 里的语音文件，而不是偷偷回退系统 TTS
//   4) 单文件版（内联语音）是否同样正常
// 需要本机装 Chrome；换路径用环境变量 CHROME 指定。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = path.join(root, 'index.html');
const standalone = path.join(root, '识字游戏-单文件版.html');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}\n用环境变量指定，例如 set CHROME=D:\\path\\to\\chrome.exe`);
  process.exit(1);
}

let failed = 0;
const ok = (m) => console.log(`  \u2713 ${m}`);
const bad = (m) => { failed++; console.log(`  \u2717 ${m}`); };
const check = (c, m) => (c ? ok(m) : bad(m));

// ---------- 从 index.html 取字表（用来判断配图指向哪个字）----------
const html = readFileSync(indexHtml, 'utf8');
const ART2CHAR = {};
for (const m of html.matchAll(/'([^']+)':\s*\{\s*id:'([a-z]+)'[^}]*?art:'([^']+)'(?:,\s*stack:\[([^\]]+)\])?/g)) {
  ART2CHAR[m[3]] = m[1];
  if (m[4]) ART2CHAR[m[4].split(',')[1].trim().replace(/'/g, '')] = m[1];
}

// ---------- 注入页面里的分析函数 ----------
const ANALYZE = `
window.audioInfo = async function(b64){
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ctx = new AudioContext();
  let audio;
  try { audio = await ctx.decodeAudioData(u8.buffer); }
  catch (e) { await ctx.close(); return { error: String(e) }; }
  const d = audio.getChannelData(0), sr = audio.sampleRate;
  const hop = Math.round(sr * 0.01);
  let from = -1, to = -1;
  for (let i = 0; i + hop <= d.length; i += hop){
    let s = 0;
    for (let j = i; j < i + hop; j++) s += d[j] * d[j];
    if (Math.sqrt(s / hop) > 0.02){ if (from < 0) from = i; to = i; }
  }
  await ctx.close();
  // to 是采样点下标，换算成毫秒要除以采样率（这里容易写成"帧下标×10"而放大 100 倍）
  return { total: Math.round(audio.duration * 1000), audibleEnd: to < 0 ? 0 : Math.round((to + hop) / sr * 1000) };
};
`;

const SPY = `
window.__plays = []; window.__spoken = [];
(function(){
  var orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function(){
    window.__plays.push({ el: this, t: Math.round(performance.now()) });
    return orig.apply(this, arguments);
  };
  if (window.speechSynthesis){
    var os = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = function(u){ window.__spoken.push(u && u.text); return os(u); };
  }
})();
`;

// 取了播放记录里的 key：单文件版是 data URI，用 window.VOICE_DATA 反查
const PROBE = `(() => window.__plays.map(p => {
  const src = p.el.currentSrc || p.el.src || '';
  let key = '';
  if (window.VOICE_DATA){
    for (const k in window.VOICE_DATA){ if (window.VOICE_DATA[k] === src){ key = k; break; } }
  }
  if (!key){
    const m = src.match(/audio[/\\\\](zi|ph|ui)[/\\\\]([^/\\\\?#]+)\\.mp3/);
    if (m) key = m[1] + '/' + m[2];
  }
  const m2 = (p.el.currentSrc || '').match(/\\/(zi|ph|ui)\\/([^\\/?#]+)\\.mp3$/);
  if (!key && m2) key = m2[1] + '/' + m2[2];
  return { key: key, dur: Math.round((p.el.duration || 0) * 1000), rs: p.el.readyState, t: p.t };
}))()`;

let port = 9800;
async function withPage(url, scenario, spy = false, size = [390, 844]) {
  const p = ++port;
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${p}`,
    `--user-data-dir=${path.join(os.tmpdir(), 'shizi-rc-' + p)}`, 'about:blank'], { stdio: 'ignore' });
  let ws, msgId = 0;
  const pending = new Map(), problems = [];
  const send = (m, pr) => { const id = ++msgId; ws.send(JSON.stringify({ id, method: m, params: pr || {} })); return new Promise((res, rej) => pending.set(id, { res, rej })); };
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  try {
    let wsUrl = null;
    for (let i = 0; i < 80 && !wsUrl; i++) {
      await sleep(150);
      try { const l = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json(); const t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl); if (t) wsUrl = t.webSocketDebuggerUrl; } catch (e) {}
    }
    if (!wsUrl) throw new Error('连不上无头 Chrome');
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result); return; }
      if (m.method === 'Runtime.exceptionThrown') problems.push('未捕获异常: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push('console.error: ' + m.params.args.map((a) => a.value ?? '').join(' '));
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 2, mobile: true });
    if (spy) await send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
    await send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) { await sleep(150); if (await evaluate('!!document.querySelector(".level-card")').catch(() => false)) break; }
    await sleep(400);
    return { out: await scenario({ evaluate, send }), problems };
  } finally {
    try { ws && ws.close(); } catch (e) {}
    proc.kill();
  }
}

// 跑一整关：每题的配图 -> 目标字 -> 点正确答案（模拟孩子听完再点）
async function playLevel({ evaluate }, levelIndex, thinkMs = 1200) {
  await evaluate(`document.querySelectorAll('.level-card')[${levelIndex}].click(); 1`);
  await sleep(2200);
  for (let q = 0; q < 5; q++) {
    const art = (await evaluate(`document.getElementById('artEmoji').innerText.replace(/\\n/g,'+')`)).split('+').pop();
    const target = ART2CHAR[art];
    if (!target) throw new Error(`认不出配图「${art}」，无法定位正确答案`);
    await sleep(thinkMs);
    const clicked = await evaluate(`(() => { const o=[...document.querySelectorAll('.opt')].find(x=>x.getAttribute('data-char')==='${target}'); if(!o) return false; o.click(); return true; })()`);
    if (!clicked) throw new Error(`选项里找不到「${target}」`);
    await sleep(3100);
  }
  await sleep(3000);
}

try {
  console.log('运行期校验（无头 Chrome 实跑）\n');

  // ---------- 1. 逐个音频：解码 + 发音结束点 ----------
  const groups = { zi: [], ph: [], ui: [] };
  for (const g of Object.keys(groups)) {
    const dir = path.join(root, 'audio', g);
    for (const f of readdirSync(dir)) if (f.endsWith('.mp3')) groups[g].push(f.slice(0, -4));
  }
  const info = {};
  {
    const { out } = await withPage('about:blank', async ({ evaluate }) => {
      await evaluate(ANALYZE);
      const all = {};
      for (const g of Object.keys(groups)) {
        for (const k of groups[g]) {
          const b64 = readFileSync(path.join(root, 'audio', g, k + '.mp3')).toString('base64');
          all[`${g}/${k}`] = await evaluate(`window.audioInfo(${JSON.stringify(b64)})`);
        }
      }
      return all;
    });
    Object.assign(info, out);
  }
  const total = Object.keys(info).length;
  const broke = Object.entries(info).filter(([, v]) => v.error || !(v.total > 0));
  check(broke.length === 0, broke.length ? `有音频解不开：${broke.map(([k]) => k).join(' ')}` : `${total} 个音频全部可解码`);
  for (const g of Object.keys(groups)) {
    const rows = Object.entries(info).filter(([k]) => k.startsWith(g + '/') && info[k].total > 0);
    const ends = rows.map(([, v]) => v.audibleEnd).sort((a, b) => a - b);
    const idx = rows.map(([, v]) => v.audibleEnd).indexOf(ends[ends.length - 1]);
    console.log(`  · ${g}/ 共 ${rows.length} 个：总长 ${Math.min(...rows.map(([, v]) => v.total))}~${Math.max(...rows.map(([, v]) => v.total))}ms，发音最长 ${ends[ends.length - 1]}ms（${rows[idx][0]}）`);
  }
  if (process.argv.includes('--verbose')) {
    console.log('');
    for (const [k, v] of Object.entries(info).sort()) {
      console.log(`  · ${k.padEnd(18)} 总长 ${String(v.total).padStart(5)}ms  发音结束 ${String(v.audibleEnd).padStart(4)}ms  句末静音 ${v.total - v.audibleEnd}ms`);
    }
  }

  // ---------- 2. index.html 跑一整关 ----------
  console.log('');
  const aud = (key) => (info[key] ? info[key].audibleEnd : 0);
  const judge = (plays, label) => {
    const missing = plays.filter((p) => !p.key);
    const clipped = [];
    for (let i = 0; i < plays.length - 1; i++) {
      const end = aud(plays[i].key);
      const gap = plays[i + 1].t - plays[i].t;
      if (end && gap + 80 < end) clipped.push(`${plays[i].key}（发音到 ${end}ms，下一段 ${gap}ms 就开始）`);
    }
    check(clipped.length === 0, clipped.length ? `${label} 有 ${clipped.length} 段被切尾：${clipped.join('；')}` : `${label} 共播 ${plays.length} 段，没有一段被切尾`);
    if (missing.length) bad(`${label} 有 ${missing.length} 段认不出来源`);
    const slow = [];
    for (let i = 0; i < plays.length - 1; i++) {
      const end = aud(plays[i].key) || plays[i].dur;
      slow.push(plays[i + 1].t - plays[i].t - end);
    }
    if (slow.length) {
      const min = Math.min(...slow);
      console.log(`  · ${label} 段落切换余量最小 ${min}ms${min < 150 ? '（偏紧）' : ''}`);
    }
  };

  const runOne = async (url, levelIndex, label) => {
    const { out, problems } = await withPage(url, async (ctx) => {
      await playLevel(ctx, levelIndex);
      return { plays: await ctx.evaluate(PROBE), spoken: await ctx.evaluate('window.__spoken'),
        screen: await ctx.evaluate(`document.querySelector('.screen.active').id`) };
    }, true);
    check(problems.length === 0, problems.length ? `${label} 报错：${problems.join('；')}` : `${label} 无运行时报错`);
    check(out.spoken.length === 0, out.spoken.length ? `${label} 回退到系统 TTS 了：${JSON.stringify(out.spoken)}` : `${label} 全程在用语音文件（TTS 调用 0 次）`);
    const rs = out.plays.filter((p) => p.rs < 1);
    check(rs.length === 0, rs.length ? `${label} 有 ${rs.length} 段没解码成功` : `${label} 所有音频都解码成功`);
    judge(out.plays, label);
    check(out.screen === 'done', out.screen === 'done' ? `${label} 走完 5 题并进入过关页` : `${label} 结束时停在 ${out.screen}，没走到过关页`);
  };

  await runOne(fileUrl(indexHtml), 2, 'index.html（第三关 3 选 1）');

  // ---------- 3. 单文件版 ----------
  console.log('');
  if (!existsSync(standalone)) {
    console.log('  · 还没生成单文件版，跳过（node tools/build-standalone.mjs）');
  } else {
    await runOne(fileUrl(standalone), 1, '单文件版（第二关 2 选 1）');
  }

  console.log(failed === 0 ? '\n全部通过 \u2728' : `\n有 ${failed} 项未通过`);
  process.exit(failed === 0 ? 0 : 1);
} catch (e) {
  console.error('校验脚本出错:', e.message);
  process.exit(1);
}

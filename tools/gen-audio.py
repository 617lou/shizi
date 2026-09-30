#!/usr/bin/env python3
"""生成识字游戏的语音文件（真人级神经网络语音，不是录音）。

用法：
    python tools/gen-audio.py                      重新生成全部语音（默认音色）
    python tools/gen-audio.py --voice zh-CN-XiaoyiNeural
    python tools/gen-audio.py --only zi/ren ph/right-ren
    python tools/gen-audio.py --force               已存在的也重生成
    python tools/gen-audio.py --samples             只生成音色对比试听文件

依赖：pip install edge-tts
产物：audio/zi/<id>.mp3（单字）、audio/ph/right-<id>.mp3（对啦，这是X）、
      audio/ui/*.mp3（界面短语）、tools/listen.html（试听页）
"""
import argparse
import asyncio
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / 'index.html'
AUDIO = ROOT / 'audio'
SAMPLE_DIR = AUDIO / '_voices'
LISTEN = ROOT / 'tools' / 'listen.html'

DEFAULT_VOICE = 'zh-CN-YunxiaNeural'
CHAR_RATE = '-15%'          # 拼音没标声调时的默认单字语速
# 单字语速按声调分开定：各调的时长需求不一样，这组值是逐轮试听后定的（见 README）
TONE_RATES = {
    '1': '-15%',  # 一声（高平）
    '2': '-15%',  # 二声（中升）
    '3': '-15%',  # 三声（降升）：曾放到 -25% 治"尾巴缺失"，换 Yunxia 后可以回到 -15%
    '4': '-25%',  # 四声（全降）：降得急，放慢些更清楚
}
UI_RATE = '+0%'
TONE_MARKS = {
    '1': 'āēīōūǖ',
    '2': 'áéíóúǘ',
    '3': 'ǎěǐǒǔǚ',
    '4': 'àèìòùǜ',
}

UI_LINES = [
    ('ui/try', '再试一次吧'),
    ('ui/done', '真棒！'),
    ('ui/alldone', '全部学完啦！你是认字小达人！'),
    ('ui/soundon', '声音打开了'),
]
SAMPLE_VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiaNeural']
SAMPLE_CHARS = [('手', 'shou', 'shǒu'), ('水', 'shui', 'shuǐ')]  # 用三声字做音色对比


def tone_of(pinyin):
    for tone, marks in TONE_MARKS.items():
        if any(m in pinyin for m in marks):
            return tone
    return '0'


def char_rate(pinyin):
    """单字语速按声调区分：孤立合成时各调的时长需求不同。"""
    return TONE_RATES.get(tone_of(pinyin), CHAR_RATE)


def parse_index():
    html = INDEX.read_text(encoding='utf-8')
    chars = [(m[0], m[1], m[2]) for m in re.findall(
        r"'([^']+)':\s*\{\s*id:'([^']+)',\s*pinyin:'([^']*)'", html)]
    levels = re.findall(r"\{ name:'([^']+)', chars:\[", html)
    if not chars or not levels:
        sys.exit('没能从 index.html 解析出字表/关卡，检查配置区格式是否被改动')
    return chars, levels


def build_jobs(chars, levels):
    jobs = []
    for ch, cid, py in chars:
        jobs.append(('zi/' + cid, ch, char_rate(py)))
        jobs.append(('ph/right-' + cid, '答对啦，这是' + ch, UI_RATE))
    for i, name in enumerate(levels, 1):
        jobs.append(('ui/lv%d' % i, name, UI_RATE))
    for key, text in UI_LINES:
        jobs.append((key, text, UI_RATE))
    return jobs


def sample_jobs():
    jobs = []
    for voice in SAMPLE_VOICES:
        short = voice.replace('zh-CN-', '').replace('Neural', '')
        for ch, cid, py in SAMPLE_CHARS:
            jobs.append(('_voices/%s-%s' % (short, cid), ch, char_rate(py), voice))
    return jobs


async def synth(key, text, rate, voice, force):
    import edge_tts
    path = AUDIO / (key + '.mp3')
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not force and path.stat().st_size > 1000:
        return ('skip', key, path.stat().st_size)
    err = None
    for attempt in range(3):
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(str(path))
            size = path.stat().st_size
            if size < 1000:
                raise RuntimeError('只有 %d 字节，可能是空文件' % size)
            return ('ok', key, size)
        except Exception as e:            # 网络抖动就退避重试
            err = e
            await asyncio.sleep(1.2 * (attempt + 1))
    return ('fail', key, str(err))


async def run(jobs, voice, force, concurrency=4):
    sem = asyncio.Semaphore(concurrency)

    async def one(job):
        async with sem:
            key, text, rate = job[0], job[1], job[2]
            v = job[3] if len(job) > 3 else voice
            return await synth(key, text, rate, v, force)

    results = await asyncio.gather(*[one(j) for j in jobs])
    ok = [r for r in results if r[0] == 'ok']
    skip = [r for r in results if r[0] == 'skip']
    fail = [r for r in results if r[0] == 'fail']
    for status, key, info in fail:
        print('  ✗ %-22s %s' % (key, info))
    total = sum(r[2] for r in ok + skip if isinstance(r[2], int))
    print('生成 %d 个、跳过 %d 个（已存在）、失败 %d 个；音频合计 %.0f KB'
          % (len(ok), len(skip), len(fail), total / 1024))
    return fail


def write_listen(chars, levels, jobs, voice):
    """生成试听页：逐个点着听，确认发音对不对。"""
    exist = lambda key: (AUDIO / (key + '.mp3')).exists()
    samples = sorted(p for p in SAMPLE_DIR.glob('*.mp3')) if SAMPLE_DIR.exists() else []

    def char_rows():
        out = []
        for ch, cid, py in chars:
            row = '<tr><td class="ch">%s</td><td><button data-src="../audio/zi/%s.mp3">%s</button>' % (ch, cid, cid)
            if exist('ph/right-' + cid):
                row += ' <button data-src="../audio/ph/right-%s.mp3">对啦，这是%s</button>' % (cid, ch)
            out.append(row + '</td></tr>')
        return '\n'.join(out)

    def ph_rows():
        out = []
        for i, name in enumerate(levels, 1):
            if exist('ui/lv%d' % i):
                out.append('<li><button data-src="../audio/ui/lv%d.mp3">%s</button></li>' % (i, name))
        for key, text in UI_LINES:
            if exist(key):
                out.append('<li><button data-src="../audio/%s.mp3">%s</button></li>' % (key, text))
        return '\n'.join(out)

    def sample_rows():
        if not samples:
            return '<li>（还没生成音色对比文件，跑 python tools/gen-audio.py --samples）</li>'
        return '\n'.join(
            '<li><button data-src="../audio/_voices/%s">%s</button></li>' % (p.name, p.stem)
            for p in samples)

    LISTEN.write_text("""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>语音试听 · 快乐认字</title>
<style>
 body{margin:0;padding:20px;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#43302b;
   background:linear-gradient(180deg,#bfe8ff,#e6f6ff 45%,#fff7e3);min-height:100vh}
 h1{font-size:22px;margin:0 0 4px}
 p.note{margin:0 0 18px;color:#5f7f96;font-size:13px}
 h2{font-size:16px;margin:22px 0 8px;color:#5f7f96}
 table{border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;
   box-shadow:0 6px 18px rgba(90,120,150,.16)}
 td{padding:6px 12px;border-bottom:1px solid #eef3f7}
 td.ch{font-size:34px;font-weight:800;line-height:1}
 button{font:inherit;font-size:13px;padding:7px 12px;margin:2px;border:0;border-radius:9px;
   background:#4aa8ff;color:#fff;font-weight:700;cursor:pointer}
 button:active{background:#2f83d6}
 ul{list-style:none;padding:0;margin:0}
 li{margin:3px 0}
 code{background:#fff;border-radius:5px;padding:1px 5px;font-size:12px}
</style></head><body>
<h1>语音试听</h1>
<p class="note">点每个按钮听一遍，确认发音对吗。当前音色：<code>__VOICE__</code>；
 全部重新生成：<code>python tools/gen-audio.py --force</code></p>
<h2>20 个单字</h2>
<table>__CHARS__</table>
<h2>界面短语</h2>
<ul>__PH__</ul>
<h2>音色对比（同一个「人」和「山」，换成喜欢的音色后重跑生成脚本）</h2>
<ul>__SAMPLES__</ul>
<script>
var cur=null;
document.addEventListener('click',function(e){
  var b=e.target.closest('button'); if(!b) return;
  if(cur){cur.pause();}
  cur=new Audio(b.getAttribute('data-src'));
  cur.play();
  b.style.background='#38c172';
  setTimeout(function(){b.style.background='';},400);
});
</script>
</body></html>
""".replace('__VOICE__', voice)
       .replace('__CHARS__', char_rows())
       .replace('__PH__', ph_rows())
       .replace('__SAMPLES__', sample_rows()), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--voice', default=DEFAULT_VOICE)
    ap.add_argument('--force', action='store_true', help='已存在的也重新生成')
    ap.add_argument('--only', nargs='*', help='只生成指定的 key，例如 zi/ren ui/try')
    ap.add_argument('--samples', action='store_true', help='只生成音色对比试听文件')
    args = ap.parse_args()

    chars, levels = parse_index()
    print('字表 %d 个字、%d 个关卡，音色 %s' % (len(chars), len(levels), args.voice))

    if args.samples:
        jobs = [(k, t, r, v) for k, t, r, v in sample_jobs()]
    else:
        jobs = build_jobs(chars, levels)
        if args.only:
            want = set(args.only)
            jobs = [j for j in jobs if j[0] in want]
            if not jobs:
                sys.exit('--only 没匹配到任何 key')
        jobs += [(k, t, r, v) for k, t, r, v in sample_jobs()]

    fails = asyncio.run(run(jobs, args.voice, args.force))
    if fails:
        sys.exit('有 %d 个文件没生成成功，检查网络后重跑' % len(fails))

    if not args.only and not args.samples:
        write_listen(chars, levels, jobs, args.voice)
        print('试听页已更新：tools/listen.html')


if __name__ == '__main__':
    main()

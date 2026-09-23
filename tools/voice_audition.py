"""生成嗓音试听页 dist/voice-audition.html：每种候选嗓音念「碰！」「三万」「胡了！」。

处理流程（语速、裁剪、响度）与 gen_voices.py 完全一致，听到的就是进游戏后的样子。

    python tools/voice_audition.py
"""
import asyncio
import base64
import io
import sys
from pathlib import Path

import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
import edge_tts  # noqa: E402
from gen_voices import process, RATE_TILE, RATE_CALL, RATE_WIN, PITCH_WIN  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "voice-audition-2.html"

# 第二组：你认可的三种嗓音做音调/语速变体（变出不同年龄感的人），再加粤语三种。
# 每项：(嗓音, 显示名, 说明, 音调偏移, 语速偏移, 文本组)
CANDIDATES = [
    ("zh-CN-XiaoxiaoNeural", "晓晓", "原声 · 温暖", "+0Hz", "+0%", "pu"),
    ("zh-CN-XiaoxiaoNeural", "晓晓 · 阿姨", "音调 −14Hz，稍慢", "-14Hz", "-6%", "pu"),
    ("zh-CN-XiaoxiaoNeural", "晓晓 · 爽利", "音调 +6Hz，稍快", "+6Hz", "+8%", "pu"),
    ("zh-CN-XiaoyiNeural", "晓伊", "原声 · 活泼", "+0Hz", "+0%", "pu"),
    ("zh-CN-XiaoyiNeural", "晓伊 · 大姐", "音调 −16Hz", "-16Hz", "-4%", "pu"),
    ("zh-CN-XiaoyiNeural", "晓伊 · 小妹", "音调 +10Hz，稍快", "+10Hz", "+6%", "pu"),
    ("zh-CN-YunxiaNeural", "云夏", "原声 · 少年感", "+0Hz", "+0%", "pu"),
    ("zh-CN-YunxiaNeural", "云夏 · 小伙", "音调 −14Hz", "-14Hz", "-4%", "pu"),
    ("zh-CN-YunxiaNeural", "云夏 · 大哥", "音调 −26Hz，稍慢", "-26Hz", "-8%", "pu"),
    ("zh-CN-YunxiaNeural", "云夏 · 老爷子", "音调 −36Hz，更慢", "-36Hz", "-14%", "pu"),
    ("zh-HK-HiuGaaiNeural", "晓佳", "女 · 粤语", "+0Hz", "+0%", "yue"),
    ("zh-HK-HiuMaanNeural", "晓曼", "女 · 粤语", "+0Hz", "+0%", "yue"),
    ("zh-HK-WanLungNeural", "云龙", "男 · 粤语", "+0Hz", "+0%", "yue"),
]
# 粤语打麻将的叫法：碰、三萬、食糊
TEXTS = {
    "pu": [("pong", "碰！", RATE_CALL), ("t2", "三万", RATE_TILE), ("win", "胡了！", RATE_WIN)],
    "yue": [("pong", "碰！", RATE_CALL), ("t2", "三萬", RATE_TILE), ("win", "食糊！", RATE_WIN)],
}


def add_pct(a, b):
    return f"{int(a.rstrip('%')) + int(b.rstrip('%')):+d}%"


def add_hz(a, b):
    return f"{int(a.rstrip('Hz')) + int(b.rstrip('Hz')):+d}Hz"


async def synth(voice, text, rate, pitch):
    for attempt in range(3):
        try:
            buf = bytearray()
            async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).stream():
                if chunk["type"] == "audio":
                    buf.extend(chunk["data"])
            samples, sr = process(bytes(buf))
            out = io.BytesIO()
            sf.write(out, samples, sr, format="MP3", subtype="MPEG_LAYER_III")
            return base64.b64encode(out.getvalue()).decode()
        except Exception:
            if attempt == 2:
                raise
            await asyncio.sleep(1.5 * (attempt + 1))


async def main():
    sem = asyncio.Semaphore(3)

    async def one(voice, text, rate, pitch):
        async with sem:
            return await synth(voice, text, rate, pitch)

    rows = []
    for voice, name, desc, pitch, rate, group in CANDIDATES:
        phrases = TEXTS[group]
        clips = await asyncio.gather(*(
            one(voice, text, add_pct(base_rate, rate), add_hz(PITCH_WIN if cid == "win" else "+0Hz", pitch))
            for cid, text, base_rate in phrases))
        btns = "".join(f'<button data-src="data:audio/mpeg;base64,{b}">{p[1]}</button>' for p, b in zip(phrases, clips))
        rows.append(
            f'<tr><td><b>{name}</b><small>{desc}</small></td>'
            f'<td class="btns">{btns}<button class="all">连播</button></td><td><code>{voice} {pitch} {rate}</code></td></tr>'
        )
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嗓音试听 第二组</title><style>
:root{{--paper:#f3f1e9;--ink:#233d35;--muted:#7a867e;--line:#dedfd4;--green:#22674f}}
body{{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI","Microsoft Yahei",sans-serif}}
main{{max-width:860px;margin:auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 6px}}p{{color:var(--muted);font-size:13px;margin:0 0 18px}}
table{{width:100%;border-collapse:collapse;background:#fffef9;border:1px solid var(--line);border-radius:10px;overflow:hidden}}
td{{padding:10px 12px;border-top:1px solid var(--line);vertical-align:middle}}tr:first-child td{{border-top:0}}
td small{{display:block;color:var(--muted);font-size:11px}}td em{{display:inline-block;margin-top:3px;font-style:normal;font-size:10px;color:#fff;background:var(--green);border-radius:4px;padding:1px 6px}}
.btns{{display:flex;flex-wrap:wrap;gap:6px}}button{{min-height:40px;padding:6px 14px;border:1px solid #d5dacf;border-radius:7px;background:#f7f6ef;font:inherit;cursor:pointer}}
button.all{{background:var(--green);color:#fff;border-color:var(--green)}}code{{font-size:10px;color:var(--muted)}}
@media (max-width:640px){{td:last-child{{display:none}}}}
</style></head><body><main><h1>嗓音试听 · 第二组</h1>
<p>第二组：你认可的晓晓、晓伊、云夏各做了几种音调/语速变体，另加粤语三种（念「碰！」「三萬」「食糊！」）。处理方式与游戏里相同。</p>
<table>{"".join(rows)}</table></main>
<script>
let cur=null;
const play=(src)=>new Promise(r=>{{if(cur)cur.pause();cur=new Audio(src);cur.onended=r;cur.play();}});
document.querySelectorAll('button[data-src]').forEach(b=>b.onclick=()=>play(b.dataset.src));
document.querySelectorAll('button.all').forEach(b=>b.onclick=async()=>{{for(const x of b.parentElement.querySelectorAll('button[data-src]')){{await play(x.dataset.src);await new Promise(r=>setTimeout(r,250));}}}});
</script></body></html>"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"{OUT}  {OUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    asyncio.run(main())

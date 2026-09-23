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
from gen_voices import process, RATE_TILE, RATE_CALL, RATE_WIN, PITCH_WIN, SEAT_VOICES  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "voice-audition.html"

CANDIDATES = [
    ("zh-CN-XiaoxiaoNeural", "晓晓", "女 · 温暖"),
    ("zh-CN-XiaoyiNeural", "晓伊", "女 · 活泼"),
    ("zh-CN-YunxiNeural", "云希", "男 · 活泼"),
    ("zh-CN-YunjianNeural", "云健", "男 · 激情"),
    ("zh-CN-YunxiaNeural", "云夏", "男 · 少年感"),
    ("zh-CN-YunyangNeural", "云扬", "男 · 播音腔"),
    ("zh-CN-liaoning-XiaobeiNeural", "晓北", "女 · 东北话"),
    ("zh-CN-shaanxi-XiaoniNeural", "晓妮", "女 · 陕西话"),
    ("zh-TW-HsiaoChenNeural", "晓臻", "女 · 台湾腔"),
    ("zh-TW-HsiaoYuNeural", "晓雨", "女 · 台湾腔"),
    ("zh-TW-YunJheNeural", "云哲", "男 · 台湾腔"),
]
PHRASES = [("pong", "碰！", RATE_CALL, "+0Hz"), ("t2", "三万", RATE_TILE, "+0Hz"), ("win", "胡了！", RATE_WIN, PITCH_WIN)]


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

    async def one(voice, p):
        async with sem:
            return await synth(voice, p[1], p[2], p[3])

    clips = {}
    for voice, _, _ in CANDIDATES:
        clips[voice] = await asyncio.gather(*(one(voice, p) for p in PHRASES))

    seat_of = {v: k for k, v in SEAT_VOICES.items()}
    seat_names = {"s0": "现在：南家", "s1": "现在：东家", "s2": "现在：北家", "s3": "现在：西家", "narrator": "现在：旁白"}
    rows = []
    for voice, name, desc in CANDIDATES:
        cur = seat_names.get(seat_of.get(voice, ""), "")
        btns = "".join(
            f'<button data-src="data:audio/mpeg;base64,{b}">{p[1]}</button>' for p, b in zip(PHRASES, clips[voice])
        )
        rows.append(
            f'<tr><td><b>{name}</b><small>{desc}</small>{f"<em>{cur}</em>" if cur else ""}</td>'
            f'<td class="btns">{btns}<button class="all">连播</button></td><td><code>{voice}</code></td></tr>'
        )
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嗓音试听</title><style>
:root{{--paper:#f3f1e9;--ink:#233d35;--muted:#7a867e;--line:#dedfd4;--green:#22674f}}
body{{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI","Microsoft Yahei",sans-serif}}
main{{max-width:860px;margin:auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 6px}}p{{color:var(--muted);font-size:13px;margin:0 0 18px}}
table{{width:100%;border-collapse:collapse;background:#fffef9;border:1px solid var(--line);border-radius:10px;overflow:hidden}}
td{{padding:10px 12px;border-top:1px solid var(--line);vertical-align:middle}}tr:first-child td{{border-top:0}}
td small{{display:block;color:var(--muted);font-size:11px}}td em{{display:inline-block;margin-top:3px;font-style:normal;font-size:10px;color:#fff;background:var(--green);border-radius:4px;padding:1px 6px}}
.btns{{display:flex;flex-wrap:wrap;gap:6px}}button{{min-height:40px;padding:6px 14px;border:1px solid #d5dacf;border-radius:7px;background:#f7f6ef;font:inherit;cursor:pointer}}
button.all{{background:var(--green);color:#fff;border-color:var(--green)}}code{{font-size:10px;color:var(--muted)}}
@media (max-width:640px){{td:last-child{{display:none}}}}
</style></head><body><main><h1>嗓音试听</h1>
<p>每种嗓音念「碰！」「三万」「胡了！」，处理方式与游戏里相同（胡了在游戏里还会再响 4 dB）。挑两个分别给南家、北家。</p>
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

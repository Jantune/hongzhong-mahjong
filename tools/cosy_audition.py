"""第三组试听：用本地 CosyVoice 3 生成方言 / 语气版本，输出 dist/voice-audition-3.html。

参考录音（谁在说）来自 assets/audio/refs/（由 tools/make_refs.py 用晓晓、晓伊、云夏生成），
指令（用什么方言、什么语气）取自 CosyVoice 源码 cosyvoice/utils/common.py 的 instruct_list。

    D:/Users/91432/Toolchains/Miniconda3/envs/cosyvoice/python.exe tools/cosy_audition.py

需要环境变量 COSYVOICE_ROOT 指向 CosyVoice 仓库（默认 D:/Users/91432/Toolchains/CosyVoice）。
"""
import base64
import io
import os
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
COSY = Path(os.environ.get("COSYVOICE_ROOT", "D:/Users/91432/Toolchains/CosyVoice"))
sys.path.insert(0, str(COSY))
sys.path.insert(0, str(COSY / "third_party" / "Matcha-TTS"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from audio_proc import process_samples  # noqa: E402

OUT = ROOT / "dist" / "voice-audition-3.html"
REFS = ROOT / "assets" / "audio" / "refs"
SPEAKERS = [("xiaoxiao", "晓晓音色"), ("xiaoyi", "晓伊音色"), ("yunxia", "云夏音色")]

PRE = "You are a helpful assistant. "
END = "<|endofprompt|>"
# (显示名, 指令, 文本组)。湖北话排第一：这是离武汉话最近的一档
STYLES = [
    ("湖北话", "请用湖北话表达。", "pu"),
    ("四川话", "请用四川话表达。", "pu"),
    ("湖南话", "请用湖南话表达。", "pu"),
    ("河南话", "请用河南话表达。", "pu"),
    ("东北话", "请用东北话表达。", "pu"),
    ("天津话", "请用天津话表达。", "pu"),
    ("山东话", "请用山东话表达。", "pu"),
    ("陕西话", "请用陕西话表达。", "pu"),
    ("上海话", "请用上海话表达。", "pu"),
    ("贵州话", "请用贵州话表达。", "pu"),
    ("云南话", "请用云南话表达。", "pu"),
    ("广东话", "请用广东话表达。", "yue"),
    ("普通话 · 很开心", "请非常开心地说一句话。", "pu"),
    ("普通话 · 大声", "Please say a sentence as loudly as possible.", "pu"),
]
TEXTS = {
    "pu": [("碰！", "碰！"), ("三万", "三万。"), ("胡了！", "胡了！")],
    "yue": [("碰！", "碰！"), ("三萬", "三萬。"), ("食糊！", "食糊！")],
}


def to_mp3_b64(samples, sr):
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="MP3", subtype="MPEG_LAYER_III")
    return base64.b64encode(buf.getvalue()).decode()


def main():
    from cosyvoice.cli.cosyvoice import AutoModel
    t0 = time.time()
    model = AutoModel(model_dir=str(COSY / "pretrained_models" / "Fun-CosyVoice3-0.5B"))
    sr = model.sample_rate
    print(f"模型加载 {time.time() - t0:.1f}s，采样率 {sr}")

    rows, n, tgen = [], 0, 0.0
    for label, instruct, group in STYLES:
        cells = []
        for spk, spk_label in SPEAKERS:
            ref = str(REFS / f"{spk}.wav")
            btns = []
            for show, text in TEXTS[group]:
                t1 = time.time()
                pieces = [j["tts_speech"].squeeze(0).cpu().numpy()
                          for j in model.inference_instruct2(text, PRE + instruct + END, ref, stream=False)]
                tgen += time.time() - t1
                n += 1
                samples = process_samples(np.concatenate(pieces), sr)
                btns.append(f'<button data-src="data:audio/mpeg;base64,{to_mp3_b64(samples, sr)}">{show}</button>')
            cells.append(f'<td><small>{spk_label}</small><div class="btns">{"".join(btns)}<button class="all">连播</button></div></td>')
        rows.append(f"<tr><th>{label}</th>{''.join(cells)}</tr>")
        print(f"{label} 完成（累计 {n} 条，平均 {tgen / n:.2f}s/条）", flush=True)

    head = "".join(f"<th>{s[1]}</th>" for s in SPEAKERS)
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嗓音试听 第三组</title><style>
:root{{--paper:#f3f1e9;--ink:#233d35;--muted:#7a867e;--line:#dedfd4;--green:#22674f}}
body{{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI","Microsoft Yahei",sans-serif}}
main{{max-width:1080px;margin:auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 6px}}p{{color:var(--muted);font-size:13px;margin:0 0 18px;line-height:1.7}}
.wrap{{overflow-x:auto}}table{{width:100%;border-collapse:collapse;background:#fffef9;border:1px solid var(--line);border-radius:10px}}
th,td{{padding:9px 10px;border-top:1px solid var(--line);vertical-align:middle;text-align:left}}thead th{{border-top:0;font-size:12px;color:var(--muted)}}
tbody th{{white-space:nowrap;font-size:13px}}td small{{display:none}}
.btns{{display:flex;flex-wrap:wrap;gap:5px}}button{{min-height:40px;padding:5px 11px;border:1px solid #d5dacf;border-radius:7px;background:#f7f6ef;font:inherit;cursor:pointer}}
button.all{{background:var(--green);color:#fff;border-color:var(--green)}}
@media (max-width:720px){{thead{{display:none}}tbody th{{display:block;border-top:2px solid var(--line)}}td{{display:block;border-top:0}}td small{{display:block;color:var(--muted);font-size:11px;margin-bottom:4px}}}}
</style></head><body><main><h1>嗓音试听 · 第三组（本地 CosyVoice 3）</h1>
<p>同一种音色（参考晓晓、晓伊、云夏）按不同方言和语气念「碰！」「三万」「胡了！」。<b>湖北话</b>是模型里离武汉话最近的一档；四川话、湖南话、贵州话、云南话与武汉话同属西南官话或相邻。最后两行是普通话的「很开心」「大声」语气，可用于胡牌。</p>
<div class="wrap"><table><thead><tr><th></th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div></main>
<script>
let cur=null;
const play=(src)=>new Promise(r=>{{if(cur)cur.pause();cur=new Audio(src);cur.onended=r;cur.play();}});
document.querySelectorAll('button[data-src]').forEach(b=>b.onclick=()=>play(b.dataset.src));
document.querySelectorAll('button.all').forEach(b=>b.onclick=async()=>{{for(const x of b.parentElement.querySelectorAll('button[data-src]')){{await play(x.dataset.src);await new Promise(r=>setTimeout(r,250));}}}});
</script></body></html>"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"{OUT}  {OUT.stat().st_size / 1024:.0f} KiB；{n} 条，生成耗时 {tgen:.0f}s")


if __name__ == "__main__":
    main()

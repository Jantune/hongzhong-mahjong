"""生成语音包检查页 dist/voice-review.html：四家座位 × 全部词条，逐条可听，用来挑出念错的。

    python tools/voice_review.py
"""
import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_spec import TILES, CALLS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
VOICE = ROOT / "assets" / "audio" / "voice"
OUT = ROOT / "dist" / "voice-review.html"
SEATS = [("s0", "南家（你）"), ("s1", "东家"), ("s2", "北家"), ("s3", "西家")]


def main():
    meta = json.loads((VOICE / "manifest.json").read_text(encoding="utf-8"))
    items = [(f"t{i}", t) for i, t in enumerate(TILES)] + list(CALLS.items())
    head = "".join(f"<th>{name}<small>{meta['voices'].get(s, '')}</small><button class='all' data-col='{i}'>连播整列</button></th>"
                   for i, (s, name) in enumerate(SEATS))
    rows = []
    for cid, text in items:
        cells = []
        for s, _ in SEATS:
            f = VOICE / s / f"{cid}.mp3"
            ms = meta["clips"].get(s, {}).get(cid, {}).get("ms", "")
            if f.exists():
                b = base64.b64encode(f.read_bytes()).decode()
                cells.append(f'<td><button data-src="data:audio/mpeg;base64,{b}">▶</button><small>{ms} ms</small></td>')
            else:
                cells.append("<td class='miss'>缺</td>")
        rows.append(f"<tr><th>{text}<small>{cid}</small></th>{''.join(cells)}</tr>")
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>语音包检查</title><style>
:root{{--paper:#f3f1e9;--ink:#233d35;--muted:#7a867e;--line:#dedfd4;--green:#22674f}}
body{{margin:0;background:var(--paper);color:var(--ink);font-family:"Segoe UI","Microsoft Yahei",sans-serif}}
main{{max-width:900px;margin:auto;padding:24px 16px}}h1{{font-size:20px;margin:0 0 6px}}p{{color:var(--muted);font-size:13px;margin:0 0 16px}}
.wrap{{overflow-x:auto}}table{{width:100%;border-collapse:collapse;background:#fffef9;border:1px solid var(--line)}}
th,td{{padding:6px 8px;border-top:1px solid var(--line);text-align:left;white-space:nowrap}}thead th{{position:sticky;top:0;background:#fffef9;vertical-align:top}}
small{{display:block;color:var(--muted);font-size:10px;font-weight:400}}button{{min-height:36px;min-width:44px;border:1px solid #d5dacf;border-radius:7px;background:#f7f6ef;font:inherit;cursor:pointer}}
button.all{{margin-top:4px;background:var(--green);color:#fff;border-color:var(--green);font-size:11px}}button.on{{outline:3px solid #be944b}}.miss{{color:#a34736}}
</style></head><body><main><h1>语音包检查</h1><p>游戏里实际使用的全部人声。点 ▶ 单条试听，「连播整列」按顺序把这一家的 41 条放一遍（当前播放的按钮会高亮）。念错的记下行名和座位即可。</p>
<div class="wrap"><table><thead><tr><th></th>{head}</tr></thead><tbody>{''.join(rows)}</tbody></table></div></main>
<script>
let cur=null;
const play=(b)=>new Promise(r=>{{if(cur)cur.pause();document.querySelectorAll('button.on').forEach(x=>x.classList.remove('on'));b.classList.add('on');cur=new Audio(b.dataset.src);cur.onended=()=>{{b.classList.remove('on');r();}};cur.play();}});
document.querySelectorAll('button[data-src]').forEach(b=>b.onclick=()=>play(b));
document.querySelectorAll('button.all').forEach(h=>h.onclick=async()=>{{const col=+h.dataset.col;for(const tr of document.querySelectorAll('tbody tr')){{const b=tr.children[col+1].querySelector('button');if(b){{await play(b);await new Promise(r=>setTimeout(r,300));}}}}}});
</script></body></html>"""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")
    print(f"{OUT}  {OUT.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()

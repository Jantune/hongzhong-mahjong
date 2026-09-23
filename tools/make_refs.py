"""为 CosyVoice 生成参考录音：用你认可的 edge-tts 嗓音念一段 6~8 秒的日常话，存成 16kHz 单声道 wav。

CosyVoice 的 instruct2 用参考录音决定「谁在说」，用指令决定「用什么方言、什么语气说」。

    python tools/make_refs.py      # 在装有 edge-tts 的环境里运行（FuelCell）
"""
import asyncio
import io
from pathlib import Path

import edge_tts
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio" / "refs"
SR = 16000

REFS = {
    "xiaoxiao": "zh-CN-XiaoxiaoNeural",
    "xiaoyi": "zh-CN-XiaoyiNeural",
    "yunxia": "zh-CN-YunxiaNeural",
}
# 语气平常、带点牌桌气氛的一段话，覆盖不同声调
TEXT = "今天手气还不错，刚才差一点就胡了。你们慢慢打，我先喝口茶，等下这把我可要认真了。"


def resample(x, sr, target=SR):
    if sr == target:
        return x
    n = int(round(len(x) * target / sr))
    return np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)


async def one(name, voice):
    buf = bytearray()
    async for chunk in edge_tts.Communicate(TEXT, voice).stream():
        if chunk["type"] == "audio":
            buf.extend(chunk["data"])
    x, sr = sf.read(io.BytesIO(bytes(buf)), dtype="float32")
    x = x.mean(axis=1) if x.ndim > 1 else x
    x = resample(x, sr)
    idx = np.where(np.abs(x) > np.abs(x).max() * 0.02)[0]
    x = x[max(idx[0] - 800, 0): idx[-1] + 3200]
    x = x * (0.9 / np.abs(x).max())
    OUT.mkdir(parents=True, exist_ok=True)
    sf.write(str(OUT / f"{name}.wav"), x, SR, subtype="PCM_16")
    print(f"{name}.wav  {len(x) / SR:.1f}s")


async def main():
    await asyncio.gather(*(one(n, v) for n, v in REFS.items()))
    (OUT / "TEXT.txt").write_text(TEXT, encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())

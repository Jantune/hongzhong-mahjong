"""生成语音包：用 edge-tts（微软神经语音）合成牌名与叫牌，再裁静音、统一响度、重编码。

    python tools/gen_voices.py            # 生成全部（已存在的跳过）
    python tools/gen_voices.py --force    # 全部重做

输出 assets/audio/voice/<seat>/<id>.mp3 与 assets/audio/voice/manifest.json。
嗓音分配改 SEAT_VOICES 即可；换嗓音后加 --force 重做。

注意：生成时会把这些词发给微软的在线朗读服务。生成物自己玩没问题，公开分发的授权属于灰色地带。
"""
import argparse
import asyncio
import io
import json
from pathlib import Path

import edge_tts
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio" / "voice"

# 座位 0 南（你）1 东 2 北 3 西；narrator 只读系统播报
SEAT_VOICES = {
    "s0": "zh-CN-YunxiNeural",            # 年轻男声，活泼
    "s1": "zh-CN-XiaoxiaoNeural",         # 女声，温暖
    "s2": "zh-CN-YunjianNeural",          # 男声，有激情
    "s3": "zh-CN-liaoning-XiaobeiNeural", # 东北话女声，诙谐
    "narrator": "zh-CN-YunyangNeural",    # 新闻男声，只读系统播报
}

NUM = "一二三四五六七八九"
TILES = [f"{n}万" for n in NUM] + [f"{n}条" for n in NUM] + [f"{n}筒" for n in NUM] + \
        ["东风", "南风", "西风", "北风", "红中", "发财", "白板"]

# id -> 念什么。叫牌带感叹号，语气更像喊出来的
CALLS = {
    "chi": "吃！",
    "pong": "碰！",
    "kong": "杠！",
    "concealedKong": "暗杠！",
    "addedKong": "蓄杠！",
    "skinKong": "皮杠！",
    "jokerKong": "赖子杠！",
    "win": "胡了！",
    "selfDraw": "自摸！",
    "gangKai": "杠上开花！",
    "haidi": "海底捞！",
    "robKong": "抢杠！",
}
NARRATOR = {"draw": "荒庄。"}


def jobs():
    for seat in ("s0", "s1", "s2", "s3"):
        for t, text in enumerate(TILES):
            yield seat, f"t{t}", text, "+0%"
        for cid, text in CALLS.items():
            yield seat, cid, text, "+8%"
    for cid, text in NARRATOR.items():
        yield "narrator", cid, text, "+0%"


def process(mp3_bytes: bytes):
    """裁掉首尾静音、20ms 淡出、按 RMS 拉到同一响度并限峰。返回 (samples, sr)。"""
    data, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    env = np.abs(data)
    thr = max(env.max() * 0.03, 1e-4)          # 约 -30 dB 相对峰值
    idx = np.where(env > thr)[0]
    if idx.size:
        a = max(idx[0] - int(0.012 * sr), 0)   # 起音前留 12ms
        b = min(idx[-1] + int(0.06 * sr), len(data))
        data = data[a:b]
    fade = min(int(0.02 * sr), len(data))
    if fade:
        data[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    rms = float(np.sqrt(np.mean(data ** 2))) or 1e-6
    data = data * (0.12 / rms)                   # 统一响度，约 -18 dBFS RMS
    peak = float(np.abs(data).max())
    if peak > 0.89:                              # 峰值天花板 -1 dBFS
        data = data * (0.89 / peak)
    return data.astype(np.float32), sr


async def one(sem, seat, cid, text, rate, force, manifest):
    path = OUT / seat / f"{cid}.mp3"
    if path.exists() and not force:
        info = sf.info(str(path))
        manifest[seat][cid] = {"text": text, "ms": round(info.duration * 1000)}
        return
    async with sem:
        buf = bytearray()
        comm = edge_tts.Communicate(text, SEAT_VOICES[seat], rate=rate)
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
    samples, sr = process(bytes(buf))
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, sr, format="MP3", subtype="MPEG_LAYER_III")
    manifest[seat][cid] = {"text": text, "ms": round(len(samples) / sr * 1000)}


async def main(force: bool):
    manifest = {seat: {} for seat in SEAT_VOICES}
    sem = asyncio.Semaphore(6)
    await asyncio.gather(*(one(sem, *j, force, manifest) for j in jobs()))
    meta = {"voices": SEAT_VOICES, "clips": manifest}
    (OUT / "manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    total = sum(p.stat().st_size for p in OUT.rglob("*.mp3"))
    n = sum(len(v) for v in manifest.values())
    print(f"{n} 条，共 {total / 1024:.0f} KiB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    asyncio.run(main(ap.parse_args().force))

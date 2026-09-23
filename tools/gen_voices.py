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

# 胡牌类：提高音调、稍放慢，语气更重；播放时 audio.mjs 另外再加 4 dB
WIN_IDS = {"win", "selfDraw", "gangKai", "haidi", "robKong"}

# 语速：默认语速下两字词的第二个字发得很轻（"三万"的"万"），放慢后每个字更完整
RATE_TILE = "-12%"
RATE_CALL = "-5%"
RATE_WIN = "-8%"
PITCH_WIN = "+15Hz"


def jobs():
    for seat in ("s0", "s1", "s2", "s3"):
        for t, text in enumerate(TILES):
            yield seat, f"t{t}", text, RATE_TILE, "+0Hz"
        for cid, text in CALLS.items():
            if cid in WIN_IDS:
                yield seat, cid, text, RATE_WIN, PITCH_WIN
            else:
                yield seat, cid, text, RATE_CALL, "+0Hz"
    for cid, text in NARRATOR.items():
        yield "narrator", cid, text, "+0%", "+0Hz"


def process(mp3_bytes: bytes):
    """裁掉首尾静音、20ms 淡出、按 RMS 拉到同一响度并限峰。返回 (samples, sr)。"""
    data, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    env = np.abs(data)
    # 起点用 -30 dB 门限找；终点门限放到约 -42 dB 并多留 150ms。
    # 之前终点也用 -30 dB，两字词第二个字的渐弱尾巴被切掉一截，听起来发轻
    idx = np.where(env > max(env.max() * 0.03, 1e-4))[0]
    tail = np.where(env > max(env.max() * 0.008, 1e-5))[0]
    if idx.size:
        a = max(idx[0] - int(0.012 * sr), 0)   # 起音前留 12ms
        b = min(tail[-1] + int(0.15 * sr), len(data))
        data = data[a:b]
    fade = min(int(0.05 * sr), len(data))
    if fade:
        data[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    rms = float(np.sqrt(np.mean(data ** 2))) or 1e-6
    data = data * (0.12 / rms)                   # 统一响度，约 -18 dBFS RMS
    peak = float(np.abs(data).max())
    if peak > 0.89:                              # 峰值天花板 -1 dBFS
        data = data * (0.89 / peak)
    return data.astype(np.float32), sr


async def one(sem, seat, cid, text, rate, pitch, force, manifest):
    path = OUT / seat / f"{cid}.mp3"
    if path.exists() and not force:
        info = sf.info(str(path))
        manifest[seat][cid] = {"text": text, "ms": round(info.duration * 1000)}
        return
    async with sem:
        # 在线服务偶尔断连，每条最多试 3 次
        for attempt in range(3):
            try:
                buf = bytearray()
                comm = edge_tts.Communicate(text, SEAT_VOICES[seat], rate=rate, pitch=pitch)
                async for chunk in comm.stream():
                    if chunk["type"] == "audio":
                        buf.extend(chunk["data"])
                break
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(1.5 * (attempt + 1))
    samples, sr = process(bytes(buf))
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), samples, sr, format="MP3", subtype="MPEG_LAYER_III")
    manifest[seat][cid] = {"text": text, "ms": round(len(samples) / sr * 1000)}


async def main(force: bool):
    manifest = {seat: {} for seat in SEAT_VOICES}
    sem = asyncio.Semaphore(3)
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

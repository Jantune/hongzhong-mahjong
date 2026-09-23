"""语音包的 edge-tts 部分：用微软神经语音合成牌名与叫牌，再裁静音、统一响度、重编码。

    python tools/gen_voices.py            # 生成（已存在的跳过）
    python tools/gen_voices.py --force    # 重做本脚本负责的座位

本脚本只负责 SEAT_VOICES 里列出的座位（南家与旁白）；东、北、西三家的方言语音由
tools/gen_voices_cosy.py 用本地 CosyVoice 3 生成。两边写 manifest.json 时都只更新自己的座位。

注意：生成时会把这些词发给微软的在线朗读服务。生成物自己玩没问题，公开分发的授权属于灰色地带。
"""
import argparse
import asyncio
import io
import json
import sys
from pathlib import Path

import edge_tts
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audio_proc import process_samples  # noqa: E402
from voice_spec import TILES, CALLS, NARRATOR, WIN_IDS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "audio" / "voice"

# 座位 0 南（你）；narrator 只读系统播报
SEAT_VOICES = {
    "s0": "zh-CN-XiaoxiaoNeural",   # 晓晓，普通话
    "narrator": "zh-CN-YunxiaNeural",  # 云夏，普通话
}

# 语速：默认语速下两字词的第二个字发得很轻（"三万"的"万"），放慢后每个字更完整
RATE_TILE = "-12%"
RATE_CALL = "-5%"
RATE_WIN = "-8%"
PITCH_WIN = "+15Hz"


def jobs():
    for seat in SEAT_VOICES:
        if seat == "narrator":
            for cid, text in NARRATOR.items():
                yield seat, cid, text, "+0%", "+0Hz"
            continue
        for t, text in enumerate(TILES):
            yield seat, f"t{t}", text, RATE_TILE, "+0Hz"
        for cid, text in CALLS.items():
            if cid in WIN_IDS:
                yield seat, cid, text, RATE_WIN, PITCH_WIN
            else:
                yield seat, cid, text, RATE_CALL, "+0Hz"


def process(mp3_bytes: bytes):
    """解码 edge-tts 的 mp3，交给公共后处理。返回 (samples, sr)。"""
    data, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
    return process_samples(data, sr), sr


def load_manifest():
    path = OUT / "manifest.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"voices": {}, "clips": {}}


def save_manifest(meta):
    (OUT / "manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")


async def one(sem, seat, cid, text, rate, pitch, force, clips):
    path = OUT / seat / f"{cid}.mp3"
    if path.exists() and not force:
        clips[cid] = {"text": text, "ms": round(sf.info(str(path)).duration * 1000)}
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
    clips[cid] = {"text": text, "ms": round(len(samples) / sr * 1000)}


async def main(force: bool):
    meta = load_manifest()
    per_seat = {seat: {} for seat in SEAT_VOICES}
    sem = asyncio.Semaphore(3)
    await asyncio.gather(*(one(sem, s, c, t, r, p, force, per_seat[s]) for s, c, t, r, p in jobs()))
    for seat, clips in per_seat.items():
        meta["clips"][seat] = clips
        meta["voices"][seat] = f"edge-tts {SEAT_VOICES[seat]}"
    save_manifest(meta)
    n = sum(len(v) for v in per_seat.values())
    print(f"edge-tts：{n} 条（{', '.join(SEAT_VOICES)}）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    asyncio.run(main(ap.parse_args().force))

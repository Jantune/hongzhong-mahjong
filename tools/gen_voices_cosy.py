"""语音包的方言部分：本地 CosyVoice 3，按座位用指定音色（参考录音）+ 方言指令生成。

    D:/Users/91432/Toolchains/Miniconda3/envs/cosyvoice/python.exe tools/gen_voices_cosy.py [--force] [--seats s1]

音色参考录音在 assets/audio/refs/（tools/make_refs.py 用 edge-tts 生成）。
CosyVoice 每次生成都带随机性，偶尔会多念字或拖长：每条做时长检查，越界就换种子重试，最多 4 次。
只更新 manifest.json 里本脚本负责的座位（东家），南家、北家、西家与旁白由 tools/gen_voices.py（edge-tts）负责。
授权：CosyVoice 代码与 Fun-CosyVoice3-0.5B 权重均为 Apache-2.0。
"""
import argparse
import json
import os
import random
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
from voice_spec import TILES, CALLS  # noqa: E402

OUT = ROOT / "assets" / "audio" / "voice"
REFS = ROOT / "assets" / "audio" / "refs"

# 座位 1 东：(参考音色, 方言, 说明)。北家普通话、西家东北话都用微软嗓音，由 gen_voices.py 负责
SEATS = {
    "s1": ("xiaoyi", "四川话", "晓伊音色 · 四川话"),
}

# 时长合理区间（秒），越界视为念错（多念字、拖长或吞字）
def bounds(cid):
    if cid.startswith("t"):
        return 0.35, 1.3
    if cid in ("chi", "pong", "kong"):
        return 0.2, 1.0
    return 0.3, 1.5


def seed_all(seed):
    import torch
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def synth(model, text, dialect, ref, seed):
    seed_all(seed)
    instruct = f"You are a helpful assistant. 请用{dialect}表达。<|endofprompt|>"
    pieces = [j["tts_speech"].squeeze(0).cpu().numpy()
              for j in model.inference_instruct2(text, instruct, ref, stream=False)]
    return process_samples(np.concatenate(pieces), model.sample_rate)


def main(force, seats):
    from cosyvoice.cli.cosyvoice import AutoModel
    t0 = time.time()
    model = AutoModel(model_dir=str(COSY / "pretrained_models" / "Fun-CosyVoice3-0.5B"))
    sr = model.sample_rate
    print(f"模型加载 {time.time() - t0:.1f}s", flush=True)

    path = OUT / "manifest.json"
    meta = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"voices": {}, "clips": {}}
    items = [(f"t{i}", t) for i, t in enumerate(TILES)] + [(cid, t) for cid, t in CALLS.items()]
    retried, failed = [], []

    for seat in seats:
        ref_name, dialect, desc = SEATS[seat]
        ref = str(REFS / f"{ref_name}.wav")
        clips = {}
        for cid, text in items:
            dst = OUT / seat / f"{cid}.mp3"
            if dst.exists() and not force:
                clips[cid] = {"text": text, "ms": round(sf.info(str(dst)).duration * 1000)}
                continue
            lo, hi = bounds(cid)
            best = None
            for attempt in range(4):
                x = synth(model, text, dialect, ref, seed=1000 + attempt)
                d = len(x) / sr
                if best is None or abs(d - (lo + hi) / 2) < abs(len(best) / sr - (lo + hi) / 2):
                    best = x
                if lo <= d <= hi:
                    best = x
                    break
            if attempt > 0:
                retried.append(f"{seat}/{cid} {text} 试了 {attempt + 1} 次")
            d = len(best) / sr
            if not lo <= d <= hi:
                failed.append(f"{seat}/{cid} {text} {d:.2f}s（区间 {lo}-{hi}）")
            dst.parent.mkdir(parents=True, exist_ok=True)
            sf.write(str(dst), best, sr, format="MP3", subtype="MPEG_LAYER_III")
            clips[cid] = {"text": text, "ms": round(d * 1000)}
        meta["clips"][seat] = clips
        meta["voices"][seat] = f"CosyVoice3 {desc}"
        path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{seat} {desc} 完成（{len(clips)} 条）", flush=True)

    print(f"重试过：{len(retried)} 条", *retried, sep="\n  ")
    print(f"仍越界：{len(failed)} 条", *failed, sep="\n  ")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--seats", default="s1")
    a = ap.parse_args()
    main(a.force, a.seats.split(","))

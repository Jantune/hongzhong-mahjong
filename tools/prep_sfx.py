"""整理落牌声与牌室环境声，输出到 assets/audio/sfx/ 与 assets/audio/ambience/。

    python tools/prep_sfx.py <T-STUDIO 解压目录下的 mp3 目录> <Freesound 牌室录音.mp3>

来源与授权：
  落牌/洗牌：T-STUDIO「Free Sound Mahjong Sound Pack」，可商用，作者希望署名「みんなの創作支援サイトＴスタ」
             https://t-studio-tst.itch.io/free-sound-mahjong-sound-pack
  环境声：   Freesound #347018 "mah_jong_parlor_outside.wav" by rasfrecci_w_donna，CC0
             https://freesound.org/people/rasfrecci_w_donna/sounds/347018/
"""
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
SFX = ROOT / "assets" / "audio" / "sfx"
AMB = ROOT / "assets" / "audio" / "ambience"
TARGET_SR = 24000


def mono(data):
    return data.mean(axis=1) if data.ndim > 1 else data


def resample(data, sr, target=TARGET_SR):
    if sr == target:
        return data
    n = int(round(len(data) * target / sr))
    x = np.linspace(0, len(data) - 1, n)
    return np.interp(x, np.arange(len(data)), data).astype(np.float32)


def trim(data, sr, pre=0.004, post=0.03, rel=0.02):
    env = np.abs(data)
    idx = np.where(env > env.max() * rel)[0]
    if not idx.size:
        return data
    a = max(idx[0] - int(pre * sr), 0)
    b = min(idx[-1] + int(post * sr), len(data))
    out = data[a:b].copy()
    f = min(int(0.015 * sr), len(out))
    out[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
    return out


def norm_peak(data, peak=0.7):
    m = float(np.abs(data).max()) or 1.0
    return (data * (peak / m)).astype(np.float32)


def write(path, data, sr):
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, format="MP3", subtype="MPEG_LAYER_III")
    print(f"{path.relative_to(ROOT)}  {len(data) / sr:.2f}s  {path.stat().st_size / 1024:.1f} KiB")


def prep_tiles(src_dir: Path):
    for i in range(1, 5):
        d, sr = sf.read(str(src_dir / f"mahjong_tile_{i}.mp3"), dtype="float32")
        d = resample(mono(d), sr)
        write(SFX / f"tile{i}.mp3", norm_peak(trim(d, TARGET_SR)), TARGET_SR)
    d, sr = sf.read(str(src_dir / "shuffle_the_mahjong_tiles.mp3"), dtype="float32")
    d = resample(mono(d), sr)
    write(SFX / "shuffle.mp3", norm_peak(trim(d, TARGET_SR, post=0.2), 0.6), TARGET_SR)


def prep_ambience(src: Path, seconds=40, xfade=3.0):
    d, sr = sf.read(str(src), dtype="float32")
    d = resample(mono(d), sr)
    sr = TARGET_SR
    # 每 0.5 秒一格的 RMS，挑一段没有突发响声（摩托车、收音机）的窗口：
    # 以窗口内最大格 / 中位格的比值最小为准
    hop = sr // 2
    rms = np.array([np.sqrt(np.mean(d[i:i + hop] ** 2)) for i in range(0, len(d) - hop, hop)])
    win = int(seconds * 2)
    best, best_score = 0, 1e9
    for s in range(0, len(rms) - win):
        w = rms[s:s + win]
        score = w.max() / (np.median(w) + 1e-9)
        if score < best_score:
            best, best_score = s, score
    start = best * hop
    seg = d[start:start + int((seconds + xfade) * sr)].copy()
    # 首尾交叉淡化成无缝循环：把多出来的 xfade 秒叠到开头
    n = int(xfade * sr)
    head, tail = seg[:n], seg[-n:]
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    seg[:n] = head * ramp + tail * (1 - ramp)
    seg = seg[:-n]
    # 环境声按 RMS 定到很低的位置，只作垫底
    seg = seg * (0.05 / (np.sqrt(np.mean(seg ** 2)) + 1e-9))
    seg = np.clip(seg, -0.8, 0.8).astype(np.float32)
    print(f"环境声取自 {start / sr:.1f}s 起，突发比 {best_score:.2f}")
    write(AMB / "parlor.mp3", seg, sr)


if __name__ == "__main__":
    prep_tiles(Path(sys.argv[1]))
    prep_ambience(Path(sys.argv[2]))

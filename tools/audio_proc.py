"""语音片段的公共后处理：裁静音、淡出、统一响度、限峰。edge-tts 与 CosyVoice 两条生成路径共用。"""
import numpy as np


def process_samples(data, sr):
    """裁掉首尾静音、50ms 淡出、按 RMS 拉到同一响度并限峰。输入输出都是 float32 单声道。"""
    data = np.asarray(data, dtype=np.float32)
    if data.ndim > 1:
        data = data.mean(axis=1)
    env = np.abs(data)
    # 起点用 -30 dB 门限找；终点门限放到约 -42 dB 并多留 150ms，
    # 否则两字词第二个字的渐弱尾巴会被切掉，听起来发轻
    idx = np.where(env > max(env.max() * 0.03, 1e-4))[0]
    tail = np.where(env > max(env.max() * 0.008, 1e-5))[0]
    if idx.size:
        a = max(idx[0] - int(0.012 * sr), 0)
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
    return data.astype(np.float32)

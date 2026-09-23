"""语音包要念的全部词条。edge-tts（gen_voices.py）与 CosyVoice（gen_voices_cosy.py）两条生成路径共用，
保证 id 与用词一致；app.mjs / audio.mjs 按这里的 id 播放。"""

NUM = "一二三四五六七八九"
TILES = [f"{n}万" for n in NUM] + [f"{n}条" for n in NUM] + [f"{n}筒" for n in NUM] + \
        ["东风", "南风", "西风", "北风", "红中", "发财", "白板"]

# id -> 念什么。叫牌带感叹号，语气更像喊出来的。
# 牌桌上只喊「杠」和「赖子杠」，明杠、蓄杠、暗杠、皮杠都用 kong
CALLS = {
    "chi": "吃！",
    "pong": "碰！",
    "kong": "杠！",
    "jokerKong": "赖子杠！",
    # 胡牌只喊三句：杠上开花喊「杠开」，其余自摸（含海底捞）喊「自摸」，胡别人的牌（含抢杠）喊「胡了」
    "win": "胡了！",
    "selfDraw": "自摸！",
    "gangKai": "杠开！",
}
NARRATOR = {"draw": "荒庄。"}

# 胡牌类：生成时语气更重，播放时 audio.mjs 另外再加 4 dB
WIN_IDS = {"win", "selfDraw", "gangKai"}


def all_clip_ids():
    return [f"t{i}" for i in range(len(TILES))] + list(CALLS)

// 手牌评估核心：向听数（shanten）、进张数（ukeire）、将眼可行性、倍数估算。
//
// 引擎自带的 fastWaits 只能回答"是否已听牌"（二值），shapeScore 是一袋手工特征，
// 两者都无法区分"还差 2 张"和"还差 3 张"。真实打法的每一个决策（打哪张、吃不吃、
// 杠不杠、推还是收）都建立在向听数之上，所以这里先把它补上。
//
// 本规则的两个硬约束被显式建模：
//   1. 屁胡必须以 2/5/8 做将；大胡不限将。实测 94% 的和牌是屁胡，所以"将眼有没有
//      着落"是这副牌最紧的约束，比任何牌型选择都重要。
//   2. 赖子是万能牌，但用赖子当万能牌就失去"硬胡"的 x2。

import { tileType, isHonor, isSuited } from './game.mjs';

export const EYE_258 = [1, 4, 7, 10, 13, 16, 19, 22, 25]; // 2/5/8 万条筒的 type 下标

const SUIT_MEMO = new Map();
const SHANTEN_MEMO = new Map();
const MEMO_LIMIT = 1 << 18;   // 并行跑十几个进程时，缓存别把内存吃光

/** 一门花色（9 种）内，允许用 g 个组位时能拿到的最大 2*面子+1*搭子。 */
function suitValues(c) {
  const key = c.join('');
  const hit = SUIT_MEMO.get(key);
  if (hit) return hit;
  const out = new Array(5).fill(0);
  for (let g = 0; g <= 4; g += 1) out[g] = suitSearch(c, 0, g);
  SUIT_MEMO.set(key, out);
  return out;
}

function suitSearch(c, i, groupsLeft) {
  while (i < 9 && c[i] === 0) i += 1;
  if (i >= 9 || groupsLeft === 0) return 0;
  c[i] -= 1;                                       // 当孤张丢掉
  let best = suitSearch(c, i, groupsLeft);
  c[i] += 1;
  if (c[i] >= 3) {                                 // 刻子
    c[i] -= 3;
    best = Math.max(best, 2 + suitSearch(c, i, groupsLeft - 1));
    c[i] += 3;
  }
  if (i + 2 < 9 && c[i + 1] > 0 && c[i + 2] > 0) { // 顺子
    c[i] -= 1; c[i + 1] -= 1; c[i + 2] -= 1;
    best = Math.max(best, 2 + suitSearch(c, i, groupsLeft - 1));
    c[i] += 1; c[i + 1] += 1; c[i + 2] += 1;
  }
  if (c[i] >= 2) {                                 // 对子搭
    c[i] -= 2;
    best = Math.max(best, 1 + suitSearch(c, i, groupsLeft - 1));
    c[i] += 2;
  }
  if (i + 1 < 9 && c[i + 1] > 0) {                 // 两面/边张搭
    c[i] -= 1; c[i + 1] -= 1;
    best = Math.max(best, 1 + suitSearch(c, i, groupsLeft - 1));
    c[i] += 1; c[i + 1] += 1;
  }
  if (i + 2 < 9 && c[i + 2] > 0) {                 // 坎张搭
    c[i] -= 1; c[i + 2] -= 1;
    best = Math.max(best, 1 + suitSearch(c, i, groupsLeft - 1));
    c[i] += 1; c[i + 2] += 1;
  }
  return best;
}

function honorValues(c) {
  const items = [];
  for (let t = 0; t < 7; t += 1) {
    if (c[t] >= 3) items.push(2);
    else if (c[t] === 2) items.push(1);
  }
  items.sort((a, b) => b - a);
  const out = new Array(5).fill(0);
  for (let g = 0; g <= 4; g += 1) out[g] = items.slice(0, g).reduce((a, b) => a + b, 0);
  return out;
}

/** 在 needGroups 个组位上可取得的最大 2*面子+1*搭子（跨花色 DP）。 */
function bestValue(counts, needGroups) {
  const blocks = [
    suitValues(counts.slice(0, 9)),
    suitValues(counts.slice(9, 18)),
    suitValues(counts.slice(18, 27)),
    honorValues(counts.slice(27, 34)),
  ];
  let dp = new Array(needGroups + 1).fill(-1);
  dp[0] = 0;
  for (const b of blocks) {
    const next = new Array(needGroups + 1).fill(-1);
    for (let used = 0; used <= needGroups; used += 1) {
      if (dp[used] < 0) continue;
      for (let g = 0; g + used <= needGroups && g <= 4; g += 1) {
        const v = dp[used] + b[g];
        if (v > next[used + g]) next[used + g] = v;
      }
    }
    dp = next;
  }
  let best = 0;
  for (const v of dp) if (v > best) best = v;
  return best;
}

/** 标准型向听的裸值（不含赖子），memo 在这一层，因为同一手牌会被反复问。 */
function standardBare(counts, needGroups, eyeRestricted) {
  const key = `${counts.join('')}|${needGroups}|${eyeRestricted ? 1 : 0}`;
  const hit = SHANTEN_MEMO.get(key);
  if (hit !== undefined) return hit;

  const eyes = eyeRestricted ? EYE_258 : ALL_TYPES;
  let best = 2 * needGroups + 2;
  for (const e of eyes) {                 // 将已成对
    if (counts[e] < 2) continue;
    counts[e] -= 2;
    const v = bestValue(counts, needGroups);
    counts[e] += 2;
    const s = 2 * needGroups - v;
    if (s < best) best = s;
  }
  for (const e of eyes) {                 // 将差一张
    if (counts[e] !== 1) continue;
    counts[e] -= 1;
    const v = bestValue(counts, needGroups);
    counts[e] += 1;
    const s = 2 * needGroups - v + 1;
    if (s < best) best = s;
  }
  {                                       // 将完全没着落
    const s = 2 * needGroups - bestValue(counts, needGroups) + 2;
    if (s < best) best = s;
  }
  if (SHANTEN_MEMO.size > MEMO_LIMIT) SHANTEN_MEMO.clear();
  SHANTEN_MEMO.set(key, best);
  return best;
}

const ALL_TYPES = Array.from({ length: 34 }, (_, i) => i);

/** 标准型向听数。0 = 已和，1 = 听牌。赖子每张顶掉一个缺口。 */
export function shantenStandard(counts, jokers, needGroups, eyeRestricted) {
  return Math.max(0, standardBare(counts, needGroups, eyeRestricted) - jokers);
}

/** 七对向听：需要 7 个对子；赖子可充当任意半对。 */
export function shantenQidui(counts, jokers, needGroups) {
  if (needGroups !== 4) return Infinity;            // 有副露就不可能七对
  let pairs = 0, kinds = 0;
  for (let t = 0; t < 34; t += 1) {
    if (counts[t] >= 2) pairs += Math.floor(counts[t] / 2);
    if (counts[t] >= 1) kinds += 1;
  }
  const usable = Math.min(pairs, 7);
  const need = 7 - usable;
  const singles = Math.max(0, kinds - usable);
  let j = jokers, made = Math.min(j, singles, need);
  j -= made;
  made += Math.min(Math.floor(j / 2), need - made);
  return Math.max(0, need - made);
}

const PENG_MEMO = new Map();

/**
 * 碰碰胡向听（不限将）。
 *
 * 原实现对每个将候选都重扫 34 种牌并排序（34x34 次，还带数组分配），被 ukeire
 * 每次调用 34 遍，是整个评估里最贵的一段。这里改成先扫一遍建小表，再对每个将
 * 候选只改动一项——语义完全相同。
 */
function pengBare(counts, needGroups) {
  const key = `${counts.join('')}|${needGroups}`;
  const hit = PENG_MEMO.get(key);
  if (hit !== undefined) return hit;

  const types = [], vals = [];
  for (let t = 0; t < 34; t += 1) {
    const n = counts[t];
    if (n >= 3) { types.push(t); vals.push(2); }
    else if (n === 2) { types.push(t); vals.push(1); }
  }
  const topSum = (arr) => {
    const c = arr.slice().sort((a, b) => b - a);
    let v = 0;
    for (let k = 0; k < needGroups && k < c.length; k += 1) v += c[k];
    return v;
  };

  let best = Infinity;
  for (let i = 0; i < types.length; i += 1) {
    const t = types[i];
    if (counts[t] < 2) continue;              // 只有对子以上能做将
    const left = counts[t] - 2;
    const adjusted = vals.slice();
    adjusted[i] = left >= 3 ? 2 : left === 2 ? 1 : 0;
    const s = 2 * needGroups - topSum(adjusted);
    if (s < best) best = s;
  }
  if (best === Infinity) best = 2 * needGroups + 2;
  if (PENG_MEMO.size > MEMO_LIMIT) PENG_MEMO.clear();
  PENG_MEMO.set(key, best);
  return best;
}

export function shantenPeng(counts, jokers, needGroups) {
  return Math.max(0, pengBare(counts, needGroups) - jokers);
}

/** 综合评估：各路线的向听数与手牌的结构性事实。 */
export function evaluateShape(counts, jokers, needGroups) {
  const pihu = shantenStandard(counts, jokers, needGroups, true);
  const qidui = shantenQidui(counts, jokers, needGroups);
  const peng = shantenPeng(counts, jokers, needGroups);

  let eyePairs = 0, eyeSingles = 0;
  for (const e of EYE_258) {
    if (counts[e] >= 2) eyePairs += 1;
    else if (counts[e] === 1) eyeSingles += 1;
  }
  let pairs = 0;
  for (let t = 0; t < 34; t += 1) if (counts[t] >= 2) pairs += Math.floor(counts[t] / 2);

  const suitTiles = [0, 0, 0];
  let honorTiles = 0, total = 0;
  for (let t = 0; t < 34; t += 1) {
    if (!counts[t]) continue;
    total += counts[t];
    if (t < 27) suitTiles[Math.floor(t / 9)] += counts[t];
    else honorTiles += counts[t];
  }
  const dominant = suitTiles.indexOf(Math.max(...suitTiles));

  return {
    pihu, qidui, peng,
    best: Math.min(pihu, qidui, peng),
    eyePairs, eyeSingles, pairs, dominant, honorTiles,
    cleanShare: total ? suitTiles[dominant] / total : 0,
  };
}

/** 从 view 抽出 counts / jokers。皮子按规则不会出现在和牌手牌里。 */
export function handShape(view, player, hand) {
  const counts = new Array(34).fill(0);
  let jokers = 0, skins = 0;
  for (const id of hand) {
    const t = tileType(id);
    if (t === view.joker) { jokers += 1; continue; }
    if (t === view.indicatorType || t === 31) { skins += 1; continue; }
    counts[t] += 1;
  }
  const needGroups = 4 - view.melds[player].length;
  return { counts, jokers, skins, needGroups, shape: evaluateShape(counts, jokers, needGroups) };
}

/**
 * 进张评估。
 *
 * 关键点：不能只数"还剩几张"，要数"**有几个来源能把它送到手上**"。
 * 手里有对子时，三家谁打出来都能碰；只差一张顺子时，只有上家打出来才能吃。
 * 同样剩 3 张的两种有效牌，到手速度差好几倍。把这一层抹平（等权数张数），
 * 向听数再准也会打出比手工启发式更慢的牌——这正是第一版每小局输 3~4 分的原因。
 *
 * pongW / chiW 是"一个对家的弃牌相当于多少次自摸机会"的折算系数。
 *
 * opt.shanten：可选，(counts, jokers, needGroups) => 向听。调用方排序出牌用的向听
 * 带了路线折价（七对 +1.5、碰碰胡 +1.0）时，进张必须用同一个函数来数，否则两边尺子不一样：
 * 打掉孤张后未折价的七对恰好领先，进张就只数凑对子的牌，屁胡路线的进张全被漏掉，
 * 结果"拆对子"反而显得比"打孤张"进张多。不传则保持原来的未折价口径。
 */
const rawShanten = (counts, jokers, needGroups) => Math.min(
  shantenStandard(counts, jokers, needGroups, true),
  shantenQidui(counts, jokers, needGroups),
  shantenPeng(counts, jokers, needGroups),
);

export function ukeire(counts, jokers, needGroups, vis, opt = {}) {
  const pongW = opt.pongW ?? 0;
  const chiW = opt.chiW ?? 0;
  const shantenOf = opt.shanten || rawShanten;
  if (rawShanten(counts, jokers, needGroups) === 0) return { kinds: 0, tiles: 0 };
  const base = shantenOf(counts, jokers, needGroups);
  let kinds = 0, tiles = 0;
  for (let t = 0; t < 34; t += 1) {
    if (counts[t] >= 4) continue;
    counts[t] += 1;
    const s = shantenOf(counts, jokers, needGroups);
    counts[t] -= 1;
    if (s >= base - 1e-9) continue;
    kinds += 1;
    const live = Math.max(0, 4 - (vis ? vis[t] : 0) - counts[t]);
    // 自摸 1 个来源；手里已有对子则三家弃牌都能碰；顺子只有上家能吃
    let ways = 1;
    if (counts[t] >= 2) ways += pongW * 3;
    else if (t < 27) ways += chiW;
    tiles += live * ways;
  }
  return { kinds, tiles };
}

/** 胡家自身倍数 W 的估算（牌型 base 之外的杠与硬胡）。 */
export function estimateW(view, player, { base = 1, usesJoker = true } = {}) {
  const kongs = view.melds[player].filter(m => m.kind === 'kong').length +
    view.specialKongs[player].filter(k => k.kind !== 'joker').length;
  const jokerKongs = view.specialKongs[player].filter(k => k.kind === 'joker').length;
  let W = base;
  if (!usesJoker) W *= 2;                 // 硬胡
  W *= 2 ** kongs;
  W *= 4 ** jokerKongs;
  return W;
}

/** 自身倍数 W 能从门清 / 开门对手手里收到多少（单人，含 4 点起收门槛）。 */
export function collectable(W, cap = 32) {
  return {
    vsClosed: W >= 4 ? Math.min(cap, W) : 0,
    vsOpen: W * 2 >= 4 ? Math.min(cap, W * 2) : 0,
  };
}

/** 自己作为输家的倍率（越低越好，这是门清与少杠的全部意义）。 */
export function ownLiability(view, player) {
  const melds = view.melds[player];
  const open = melds.some(m => m.open) ? 2 : 1;
  const kongs = melds.filter(m => m.kind === 'kong').length +
    view.specialKongs[player].filter(k => k.kind !== 'joker').length;
  const jokerKongs = view.specialKongs[player].filter(k => k.kind === 'joker').length;
  return open * 2 ** kongs * 4 ** jokerKongs;
}

/**
 * 对手威胁度。
 *
 * 关键校准：皮杠是**强制**的——皮子既不能打也不能留着胡牌，摸到就只能杠。
 * 所以皮杠完全不携带"这家牌好"的信息，把它计入威胁会让全场从中盘起一直处于
 * 高威胁状态，防守策略于是永远在弃和。只有自选的动作（吃碰、普通杠、赖杠）
 * 才说明对方在推进。
 */
export function threatOf(view, p) {
  const melds = view.melds[p] || [];
  const special = view.specialKongs[p] || [];
  const realKongs = melds.filter(m => m.kind === 'kong').length +
    special.filter(k => k.kind === 'joker').length;
  const open = melds.filter(m => m.open).length;
  let t = open * 0.9 + realKongs * 1.4;
  if (view.wall <= 28) t += 0.5;
  if (view.wall <= 14) t += 1.0;
  return t;
}

export function maxThreat(view, player) {
  let m = 0;
  for (let p = 0; p < 4; p += 1) {
    if (p === player) continue;
    m = Math.max(m, threatOf(view, p));
  }
  return m;
}

/** 全场可见的每种牌张数。 */
export function visibleCounts(view) {
  const vis = new Array(34).fill(0);
  for (let p = 0; p < 4; p += 1) {
    for (const id of view.discards[p]) vis[tileType(id)] += 1;
    for (const m of view.melds[p]) for (const id of m.tiles) vis[tileType(id)] += 1;
    for (const k of view.specialKongs[p]) vis[tileType(k.tile)] += 4;
  }
  if (view.indicator !== undefined) vis[tileType(view.indicator)] += 1;
  return vis;
}

/** 单张牌的危险度。本规则无振听，只能用剩余张数与牌形推断。 */
export function dangerOf(t, vis, ownCount) {
  const remaining = Math.max(0, 4 - vis[t] - (ownCount || 0));
  let d = remaining;
  if (isHonor(t)) d -= 1.2;
  if (isSuited(t)) {
    const r = (t % 9) + 1;
    if (r === 1 || r === 9) d -= 0.8;
    else if (r === 2 || r === 8) d += 0.3;   // 2/8 兼任屁胡的将
    else if (r >= 4 && r <= 6) d += 0.6;
    if (r === 5) d += 0.3;
  }
  return Math.max(0, d);
}

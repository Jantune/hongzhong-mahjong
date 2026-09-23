// 离线出牌建议。完全本地计算，不联网、不需要任何密钥。
//
// 建议由 handeval.mjs 的向听引擎给出——它在 22,255 个局面上与引擎自带的
// fastCanWin / fastWaits 交叉验证过，0 处不一致。这里只负责把那些数字翻译成
// 人能读的话，不做任何额外的猜测。

import { legalActions, tileType, NAMES, evaluateWin, fastWaits } from './game.mjs';
import {
  handShape, shantenStandard, shantenQidui, shantenPeng,
  ukeire, visibleCounts, dangerOf, maxThreat, EYE_258,
} from './handeval.mjs';

const QIDUI_PEN = 1.5;
const PENG_PEN = 1.0;

function bestShanten(counts, jokers, needGroups, hasChi) {
  let best = shantenStandard(counts, jokers, needGroups, true);
  if (needGroups === 4) best = Math.min(best, shantenQidui(counts, jokers, needGroups) + QIDUI_PEN);
  if (!hasChi) best = Math.min(best, shantenPeng(counts, jokers, needGroups) + PENG_PEN);
  return best;
}

function shantenAfterBestDiscard(counts, jokers, needGroups, hasChi) {
  let best = Infinity;
  for (let t = 0; t < 34; t += 1) {
    if (!counts[t]) continue;
    counts[t] -= 1;
    const s = bestShanten(counts, jokers, needGroups, hasChi);
    counts[t] += 1;
    if (s < best) best = s;
  }
  if (jokers > 0) best = Math.min(best, bestShanten(counts, jokers - 1, needGroups, hasChi));
  return best === Infinity ? bestShanten(counts, jokers, needGroups, hasChi) : best;
}

/** 内部用的"还差几张"换算成牌手习惯的向听数：听牌 = 0。 */
function toXiangting(s) {
  return Math.max(0, Math.round(s) - 1);
}

export function xiangtingText(s) {
  const x = toXiangting(s);
  if (x === 0) return '听牌';
  return `${x} 向听`;
}

const DANGER_LEVELS = [
  { max: 1.0, label: '很安全', rank: 0 },
  { max: 2.0, label: '较安全', rank: 1 },
  { max: 3.2, label: '一般', rank: 2 },
  { max: 4.2, label: '偏危险', rank: 3 },
  { max: Infinity, label: '危险', rank: 4 },
];

function dangerInfo(t, vis, ownCount) {
  const d = dangerOf(t, vis, ownCount);
  const live = Math.max(0, 4 - vis[t] - ownCount);
  const level = DANGER_LEVELS.find((x) => d <= x.max);
  return { score: d, live, label: level.label, rank: level.rank };
}

/** 手牌层面的硬性提醒：这些是规则强制的，漏掉就直接胡不了。 */
function warningsFor(view, player, counts, jokers, hand) {
  const out = [];
  const skins = hand.filter((id) => {
    const t = tileType(id);
    return t === view.indicatorType || t === 31;
  }).length;
  if (skins > 0) {
    // "胡牌前必须杠掉" 是硬规则；"现在就杠" 只是建议——两者别混为一谈
    out.push(`手上有 ${skins} 张皮子。皮子打不出去，且只要还在手上就不能胡，所以胡牌前必须把它杠掉；`
      + `什么时候杠可以自己选。`);
  }
  if (jokers >= 2) {
    out.push('手上两张赖子，普通屁胡被禁。开一个赖杠既解禁又拿 ×4，实测这是全场最高收益的操作。');
  }
  let eyePairs = 0, eyeSingles = 0;
  for (const e of EYE_258) {
    if (counts[e] >= 2) eyePairs += 1;
    else if (counts[e] === 1) eyeSingles += 1;
  }
  if (eyePairs === 0 && jokers === 0) {
    out.push(eyeSingles > 0
      ? `没有成对的 2/5/8 将，屁胡还差一个将。手上有 ${eyeSingles} 张 2/5/8 单张，别随手打掉。`
      : '手上一张 2/5/8 都没有，屁胡这条路目前是断的——要么摸将，要么走七对/碰碰胡。');
  }
  const threat = maxThreat(view, player);
  if (threat >= 3.0) {
    const who = [];
    for (let p = 0; p < 4; p += 1) {
      if (p === player) continue;
      const melds = view.melds[p] || [];
      const open = melds.filter((m) => m.open).length;
      const kongs = melds.filter((m) => m.kind === 'kong').length +
        (view.specialKongs[p] || []).filter((k) => k.kind === 'joker').length;
      if (open + kongs >= 2) who.push(p);
    }
    if (who.length) out.push(`有人推得很凶（副露/杠较多），这时打生张风险偏高。`);
  }
  return out;
}

/**
 * 给出当前该怎么走。返回结构化数据，渲染层只负责显示。
 * view 必须是 visibleState(state, player)。
 */
export function advise(view, player = 0) {
  if (!view || view.phase === 'done') return null;
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const hand = view.hands[player];
  if (!Array.isArray(hand) || hand.some((x) => x === null)) return null;
  const { counts, jokers, needGroups } = handShape(view, player, hand);
  const hasChi = (view.melds[player] || []).some((m) => m.kind === 'chi');
  const vis = visibleCounts(view);
  const warnings = warningsFor(view, player, counts, jokers, hand);

  const win = actions.find((a) => a.kind === 'win');
  if (win) {
    return { mode: 'win', headline: '可以胡牌 —— 胡。', detail: '引擎已经确认这手牌满足 4 点起胡门槛，没有理由放过。', rows: [], warnings, best: win };
  }

  // ---- 别人打牌，轮到你决定吃/碰/杠/过 ----
  if (view.pending) {
    const cur = bestShanten(counts, jokers, needGroups, hasChi);
    const rows = [];
    for (const a of actions) {
      if (!['chi', 'pong', 'exposedKong'].includes(a.kind)) continue;
      const after = counts.slice();
      const t = tileType(a.tile);
      let ok = true;
      if (a.kind === 'exposedKong') {
        if (after[t] < 3) ok = false; else after[t] -= 3;
      } else {
        for (const id of a.tiles) {
          const u = tileType(id);
          if (after[u] <= 0) { ok = false; break; }
          after[u] -= 1;
        }
      }
      if (!ok) continue;
      const s = shantenAfterBestDiscard(after, jokers, needGroups - 1, hasChi || a.kind === 'chi');
      rows.push({ action: a, kind: a.kind, gain: cur - s, shanten: s });
    }
    rows.sort((x, y) => y.gain - x.gain);
    const top = rows[0];
    // 判据：向听真的改善才鸣。开门会把你输牌时的赔付倍率 x2，白鸣是净亏。
    const worth = top && top.gain >= 1;
    const pass = actions.find((a) => a.kind === 'pass');
    return {
      mode: 'call',
      headline: worth
        ? `建议${kindLabel(top.kind)} —— 向听能降 ${Math.round(top.gain)} 步`
        : rows.length ? '建议过 —— 鸣了也不会更近' : '建议过',
      detail: worth
        ? `鸣牌后 ${xiangtingText(top.shanten)}。`
        : rows.length
          ? '开门会把你输牌时的赔付倍率翻倍，向听不降就是净亏。'
          : '没有能让手牌变好的选择。',
      rows: rows.map((r) => ({
        label: `${kindLabel(r.kind)}`,
        shanten: r.shanten,
        gain: r.gain,
        recommended: worth && r === top,
      })),
      warnings,
      best: worth ? top.action : pass,
    };
  }

  // ---- 自己回合的杠 ----
  // 面板不替你决定杠不杠：有杠可开时照常给出牌建议，只在末尾附一句"或者开某杠"。
  // 杠是个取舍（×2/×4 与补牌 vs 自身赔付倍率也翻倍、还可能搏杠上开花），
  // 把它做成一条硬建议会掩盖掉这个取舍。
  const KONG_LABEL = { skinKong: '皮杠', jokerKong: '赖杠', concealedKong: '暗杠', addedKong: '蓄杠' };
  const kongOptions = actions.filter((a) => Object.hasOwn(KONG_LABEL, a.kind));
  const kongNote = kongOptions.length
    ? `或者${[...new Set(kongOptions.map((a) => `开${KONG_LABEL[a.kind]} ${NAMES[tileType(a.tile)]}`))].join(' / ')}。`
    : '';

  // ---- 出牌 ----
  const discards = actions.filter((a) => a.kind === 'discard');
  if (!discards.length) {
    // 没牌可打（手上全是皮子之类）时才把杠当成唯一可走的一步
    const only = kongOptions[0];
    return only
      ? { mode: 'kong', headline: `开${KONG_LABEL[only.kind]} ${NAMES[tileType(only.tile)]}`, detail: '这一手没有可打的牌。', rows: [], warnings, best: only }
      : { mode: 'none', headline: '', detail: '', rows: [], warnings, best: null };
  }

  const seen = new Set();
  const rows = [];
  for (const a of discards) {
    const t = tileType(a.tile);
    if (seen.has(t)) continue;
    seen.add(t);
    const isJoker = t === view.joker;
    let s, uk;
    // 进张用与向听同一把尺子（带七对/碰碰胡折价）来数，否则会把"拆对子"排到"打孤张"前面
    const uopt = { pongW: 0.8, chiW: 0.2, shanten: (c, j, g) => bestShanten(c, j, g, hasChi) };
    if (isJoker) {
      s = bestShanten(counts, jokers - 1, needGroups, hasChi);
      uk = ukeire(counts, jokers - 1, needGroups, vis, uopt);
    } else {
      counts[t] -= 1;
      s = bestShanten(counts, jokers, needGroups, hasChi);
      uk = ukeire(counts, jokers, needGroups, vis, uopt);
      counts[t] += 1;
    }
    const own = hand.filter((id) => tileType(id) === t).length;
    const dg = dangerInfo(t, vis, own);
    rows.push({ action: a, tile: a.tile, type: t, isJoker, shanten: s, uk, danger: dg });
  }

  const minS = Math.min(...rows.map((r) => r.shanten));
  // 与 Efficient 策略同一套评分：向听为主（200/步），进张为辅（0.3 权重）
  for (const r of rows) {
    r.score = -r.shanten * 200 + (r.uk.tiles * 6 + r.uk.kinds * 2) * 0.3 - (r.isJoker ? 150 : 0);
  }
  // 同分时先打"留着最没用"的牌，而不是按手牌顺序随便挑：字牌、幺九最先走，
  // 2/5/8 是屁胡将眼候选、最后才动。面板自己的提醒里就写着"2/5/8 单张别随手打掉"，
  // 不加这一条，同分时它反而会推荐打二万。
  rows.sort((a, b) => (Math.abs(b.score - a.score) > 1e-6 ? b.score - a.score : keepValue(a.type) - keepValue(b.type)));
  const top = rows[0];
  top.recommended = true;

  // 听牌与 1 向听时列出具体的牌和场上剩余张数：
  //   听牌   —— 真正能胡的牌（走完整的胡牌判定：有皮不能胡、两赖禁屁胡、4 点起胡）
  //   1 向听 —— 摸到就能听牌的牌
  const shown = rows.slice(0, 3);
  for (const r of shown) {
    const x = toXiangting(r.shanten);
    if (x === 0) r.waits = waitsAfterDiscard(view, player, r.isJoker ? null : r.tile, r.isJoker ? r.tile : null, vis);
    else if (x === 1) r.next = (r.uk.list || []).map((e) => ({ ...e, joker: e.t === view.joker })).sort((a, b) => b.live - a.live);
  }
  const tenpai = toXiangting(top.shanten) === 0;
  return {
    mode: 'discard',
    headline: `建议打 {TILE}`,
    headlineTile: top.tile,
    detail: tenpai
      ? (top.waits.some((w) => w.ok)
        ? `打完听牌：听 ${tileCountText(top.waits.filter((w) => w.ok))}。`
          + (top.waits.some((w) => !w.ok) ? `（${top.waits.filter((w) => !w.ok).map(tileLabel).join('、')}打点不够 4，胡不了）` : '')
        : top.waits.length
          ? `打完听 ${tileCountText(top.waits)}，但眼下打点不够 4，胡不了：没人开口、也没杠，屁胡每家只付 2。等有人开口或自己开杠才能胡。`
          : '打完听牌，但眼下胡不了（手上有皮要先杠掉）。')
      : toXiangting(top.shanten) === 1 && top.next?.length
        ? `打完 1 向听，摸到 ${tileCountText(top.next)} 就听牌。`
        : `打完 ${xiangtingText(top.shanten)}，有效牌 ${top.uk.kinds} 种。`,
    kongNote,
    rows: rows.slice(0, 3),
    minS,
    warnings,
    best: top.action,
  };
}

/** "三万（剩 2）、六万（剩 3），共 5 张" */
export function tileCountText(list) {
  const total = list.reduce((s, x) => s + x.live, 0);
  return `${list.map((x) => `${tileLabel(x)}（剩 ${x.live}）`).join('、')}，共 ${total} 张`;
}

/** 赖子标成「赖子南」，免得「听南」被误会成要一张真南风 */
export function tileLabel(x) {
  return `${x.joker ? '赖子' : ''}${NAMES[x.t]}`;
}

/**
 * 打掉 discardId 之后听哪些牌，以及每种在场上还剩几张。
 * 牌型听牌（fastWaits）与完整胡牌判定（evaluateWin：自摸或任一家点炮）取并集；
 * ok = false 表示牌型听了但眼下胡不了（最常见：没人开口也没杠，硬屁胡每家只付 2 点，够不上 4 点起胡）。
 * 皮子本身不算听牌。
 */
function waitsAfterDiscard(view, player, discardId, jokerDiscardId, vis) {
  const drop = discardId ?? jokerDiscardId;
  const hand = view.hands[player].filter((id) => id !== drop);
  const shape = new Set(fastWaits(view, player, hand));
  const out = [];
  for (let t = 0; t < 34; t += 1) {
    if (t === 31 || t === view.indicatorType) continue;
    const own = hand.filter((id) => tileType(id) === t).length;
    if (own >= 4) continue;
    const id = [t * 4, t * 4 + 1, t * 4 + 2, t * 4 + 3].find((x) => !hand.includes(x));
    const probe = { ...view, hands: view.hands.map((h, p) => (p === player ? hand : h)) };
    const selfProbe = { ...probe, hands: probe.hands.map((h, p) => (p === player ? [...hand, id] : h)) };
    let ok = !!evaluateWin(selfProbe, player, { selfDraw: true });
    for (let d = 1; !ok && d < 4; d += 1) ok = !!evaluateWin(probe, player, { from: (player + d) % 4, tile: id });
    if (ok || shape.has(t)) out.push({ t, live: Math.max(0, 4 - vis[t] - own), ok, joker: t === view.joker });
  }
  return out;
}

/** 留着这张牌的潜在价值，只用于同分裁决。字牌 0；幺九 1；二八 2；三到七 3；2/5/8 另加 2。 */
function keepValue(t) {
  if (t >= 27) return 0;
  const rank = (t % 9) + 1;
  const base = rank === 1 || rank === 9 ? 1 : rank === 2 || rank === 8 ? 2 : 3;
  return base + (EYE_258.includes(t) ? 2 : 0);
}

function kindLabel(kind) {
  return { chi: '吃', pong: '碰', exposedKong: '明杠' }[kind] || kind;
}

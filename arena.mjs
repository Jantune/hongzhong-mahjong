// 复式对局评测台（duplicate-seating arena）。
//
// 修掉原 simulate_tournament.mjs 的三处方法论问题：
//   1. 原轮转只做 4 种循环移位，桌上的相对邻座顺序恒定不变。而本规则只能吃上家，
//      所以"谁坐谁的下家"是结构性变量。这里跑满 24 种座位排列（4 种庄位 x 6 种
//      循环顺序），邻座与庄位同时被均衡。
//   2. 原设计每阶段同时更换阵容、种子与对手池，无法归因。这里固定种子做复式：
//      createGame 的发牌只取决于 seed，与庄家无关，所以同一个 seed 下 24 种排列
//      里每个策略都会拿到同一副牌的每一个门，各 6 次。方差被大幅消掉。
//   3. 原主指标"比赛胜率 / 场均净胜分"耦合了 -300 飞局这个终止条件。这里主指标
//      改为每小局净分，并对 block（独立牌局种子）做 bootstrap 置信区间。

import { createGame, nextRound, applyAction, tileType } from './game.mjs';

export const PERMS = (() => {
  const out = [];
  const a = [0, 1, 2, 3];
  const rec = (cur, rest) => {
    if (!rest.length) { out.push(cur.slice()); return; }
    for (let i = 0; i < rest.length; i += 1) {
      rec([...cur, rest[i]], rest.filter((_, k) => k !== i));
    }
  };
  rec([], a);
  return out;                       // 24
})();

function emptyStat(name) {
  return {
    name, rounds: 0, points: 0,
    wins: 0, selfDraws: 0, dealIns: 0,
    wSum: 0, gainSum: 0, paidSum: 0, payEvents: 0,
    openRounds: 0, liabilitySum: 0, kongSum: 0,
    gangKai: 0,               // 杠上开花次数
    gangKaiGain: 0,           // 杠上开花收到的总分
    ronGain: 0, ronWins: 0,   // 点炮胡的次数与总分
    tsumoGain: 0,             // 普通自摸（不含杠上开花）的总分
    bigWins: 0, bigGain: 0,   // 大胡（碰碰胡、清一色等，含杠上开花）
    cleanWins: 0, pengWins: 0, pairWins: 0,   // 清一色 / 碰碰胡 / 七对 次数
  };
}

function ownLiabilityOf(state, p) {
  const melds = state.melds[p];
  const open = melds.some(m => m.open) ? 2 : 1;
  const kongs = melds.filter(m => m.kind === 'kong').length +
    state.specialKongs[p].filter(k => k.kind === 'skin').length;
  const jk = state.specialKongs[p].filter(k => k.kind === 'joker').length;
  return open * 2 ** kongs * 4 ** jk;
}

/** 跑完一局（一小局），返回终局 state。 */
function playRound(state, policies, maxSteps = 800) {
  let steps = 0;
  while (state.phase !== 'done' && steps < maxSteps) {
    const player = state.pending
      ? Number(Object.keys(state.pending.responses).find(k => state.pending.responses[k] === undefined))
      : state.turn;
    if (!Number.isInteger(player)) return { state, stalled: true };
    const action = policies[player](state, player);
    if (!action) return { state, stalled: true };
    state = applyAction(state, action);
    steps += 1;
  }
  return { state, stalled: state.phase !== 'done' };
}

function record(stats, seatNames, state, before) {
  const res = state.result;
  for (let p = 0; p < 4; p += 1) {
    const s = stats[seatNames[p]];
    s.rounds += 1;
    s.points += state.scores[p] - before[p];
    s.liabilitySum += ownLiabilityOf(state, p);
    s.kongSum += state.melds[p].filter(m => m.kind === 'kong').length + state.specialKongs[p].length;
    if (state.melds[p].some(m => m.open)) s.openRounds += 1;
  }
  if (!res || res.type !== 'win' || res.winner === null) return;
  const w = stats[seatNames[res.winner]];
  w.wins += 1;
  w.wSum += res.score?.W || 0;
  w.gainSum += res.score?.total || 0;
  if (res.from === null) w.selfDraws += 1;
  else if (res.from !== res.winner) stats[seatNames[res.from]].dealIns += 1;
  const gain = res.score?.total || 0;
  if ((res.score?.labels || []).includes('杠上开花')) { w.gangKai += 1; w.gangKaiGain += gain; }
  else if (res.from === null) w.tsumoGain += gain;
  else { w.ronWins += 1; w.ronGain += gain; }
  const labels = res.score?.labels || [];
  if (res.score?.big) { w.bigWins += 1; w.bigGain += gain; }
  if (labels.includes('清一色')) w.cleanWins += 1;
  if (labels.includes('碰碰胡')) w.pengWins += 1;
  if (res.score?.sevenPairs) w.pairWins += 1;
  for (let p = 0; p < 4; p += 1) {
    if (p === res.winner) continue;
    const pay = res.score?.payments?.[p] || 0;
    if (pay > 0) { stats[seatNames[p]].paidSum += pay; stats[seatNames[p]].payEvents += 1; }
  }
}

/**
 * 复式单局模式：每个 block 是一副固定的牌，24 种座位排列各打一次。
 * lineup 里可以重复出现同一个策略名。
 */
export function runDuplicate({ lineup, strategies, blocks = 100, seedStart = 10000, cap = 50,
  shard = 0, shardCount = 1 } = {}) {
  const names = [...new Set(lineup)];
  const stats = {}; for (const n of names) stats[n] = emptyStat(n);
  const blockPoints = [];               // 每个 block 内各策略的净分，用于 bootstrap
  let stalled = 0, roundsTotal = 0;

  for (let b = 0; b < blocks; b += 1) {
    if (b % shardCount !== shard) continue;
    const seed = seedStart + b * 1009;
    const local = {}; for (const n of names) local[n] = { pts: 0, rounds: 0 };
    for (const perm of PERMS) {
      const seatNames = [0, 1, 2, 3].map(s => lineup[perm[s]]);
      const policies = seatNames.map(n => strategies[n]);
      let state = createGame({ cap, seed, dealer: 0, scores: [0, 0, 0, 0], round: 1 });
      const before = [0, 0, 0, 0];
      const out = playRound(state, policies);
      if (out.stalled) { stalled += 1; continue; }
      record(stats, seatNames, out.state, before);
      roundsTotal += 1;
      for (let p = 0; p < 4; p += 1) {
        local[seatNames[p]].pts += out.state.scores[p];
        local[seatNames[p]].rounds += 1;
      }
    }
    blockPoints.push(local);
  }
  return { lineup, stats, blockPoints, stalled, roundsTotal, mode: 'duplicate' };
}

/**
 * 飞局模式：分数 <= bust 结束（默认封顶 50，与游戏一致），座位排列跑满 24 种。
 * 游戏里的锦标赛是 300 点起、跌破 0 结束，对应 startScore = 300、bust = -1。
 * 每场记录名次（同分取较好名次），blockPoints 里带 rankSum / matches，便于按块配对比较名次。
 */
export function runBust({ lineup, strategies, blocks = 20, seedStart = 20000, cap = 50,
  bust = -300, startScore = 0, maxRounds = 80, shard = 0, shardCount = 1 } = {}) {
  const names = [...new Set(lineup)];
  const stats = {}; for (const n of names) stats[n] = emptyStat(n);
  for (const n of names) {
    Object.assign(stats[n], { matches: 0, matchWins: 0, busted: 0, finalSum: 0, rankSum: 0, unfinished: 0, matchRounds: 0 });
  }
  const blockPoints = [];
  let stalled = 0, roundsTotal = 0;

  for (let b = 0; b < blocks; b += 1) {
    if (b % shardCount !== shard) continue;
    const seed = seedStart + b * 1009;
    const local = {}; for (const n of names) local[n] = { pts: 0, rounds: 0, rankSum: 0, matches: 0, busted: 0, firsts: 0 };
    // 阵容里有同名策略时（例如两家精算对两家激情），24 种排列里有重复的座次；
    // 策略与发牌都是确定性的，重复的座次打出来一模一样，只算一次。
    const seenSeats = new Set();
    for (const perm of PERMS) {
      const seatNames = [0, 1, 2, 3].map(s => lineup[perm[s]]);
      const seatKey = seatNames.join('|');
      if (seenSeats.has(seatKey)) continue;
      seenSeats.add(seatKey);
      const policies = seatNames.map(n => strategies[n]);
      const s0 = startScore;
      let state = createGame({ cap, seed, dealer: 0, scores: [s0, s0, s0, s0], round: 1 });
      let r = 0;
      while (r < maxRounds && !state.scores.some(s => s <= bust)) {
        const before = [...state.scores];
        const out = playRound(state, policies);
        if (out.stalled) { stalled += 1; break; }
        state = out.state;
        record(stats, seatNames, state, before);
        roundsTotal += 1; r += 1;
        for (let p = 0; p < 4; p += 1) {
          local[seatNames[p]].pts += state.scores[p] - before[p];
          local[seatNames[p]].rounds += 1;
        }
        if (state.scores.some(s => s <= bust)) break;
        state = nextRound(state);
      }
      const final = [...state.scores];
      const order = [0, 1, 2, 3].sort((x, y) => final[y] - final[x]);
      const finished = final.some(s => s <= bust);
      for (let p = 0; p < 4; p += 1) {
        const s = stats[seatNames[p]];
        const rank = 1 + final.filter(v => v > final[p]).length;   // 同分取较好名次
        s.matches += 1; s.finalSum += final[p]; s.rankSum += rank; s.matchRounds += r;
        if (!finished) s.unfinished += 1;
        if (final[p] <= bust) { s.busted += 1; local[seatNames[p]].busted += 1; }
        if (rank === 1) local[seatNames[p]].firsts += 1;
        local[seatNames[p]].rankSum += rank;
        local[seatNames[p]].matches += 1;
      }
      stats[seatNames[order[0]]].matchWins += 1;
    }
    blockPoints.push(local);
  }
  return { lineup, stats, blockPoints, stalled, roundsTotal, mode: 'bust' };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 对 block 重抽样，给出每小局净分的 95% 置信区间。 */
export function bootstrapCI(blockPoints, name, iters = 4000, seed = 12345) {
  const blocks = blockPoints
    .map(bp => bp[name])
    .filter(x => x && x.rounds > 0);
  if (!blocks.length) return { mean: 0, lo: 0, hi: 0, n: 0 };
  const rnd = mulberry(seed);
  const mean = blocks.reduce((a, b) => a + b.pts, 0) / blocks.reduce((a, b) => a + b.rounds, 0);
  const samples = new Array(iters);
  for (let i = 0; i < iters; i += 1) {
    let pts = 0, rounds = 0;
    for (let k = 0; k < blocks.length; k += 1) {
      const pick = blocks[(rnd() * blocks.length) | 0];
      pts += pick.pts; rounds += pick.rounds;
    }
    samples[i] = pts / rounds;
  }
  samples.sort((a, b) => a - b);
  return {
    mean,
    lo: samples[Math.floor(iters * 0.025)],
    hi: samples[Math.floor(iters * 0.975)],
    n: blocks.length,
  };
}

export function mergeResults(parts) {
  const base = parts[0];
  const names = Object.keys(base.stats);
  const stats = {};
  for (const n of names) {
    stats[n] = { ...base.stats[n] };
    for (const p of parts.slice(1)) {
      for (const k of Object.keys(stats[n])) {
        if (typeof stats[n][k] === 'number') stats[n][k] += p.stats[n][k];
      }
    }
  }
  return {
    lineup: base.lineup,
    mode: base.mode,
    stats,
    blockPoints: parts.flatMap(p => p.blockPoints),
    stalled: parts.reduce((a, p) => a + p.stalled, 0),
    roundsTotal: parts.reduce((a, p) => a + p.roundsTotal, 0),
  };
}

export function report(result, title) {
  const { stats, blockPoints, mode } = result;
  const names = Object.keys(stats);
  const lines = [];
  lines.push(`\n### ${title}`);
  lines.push(`模式=${mode}  总小局=${result.roundsTotal}  独立牌局种子=${blockPoints.length}  未完成局=${result.stalled}`);
  lines.push('');
  const head = mode === 'bust'
    ? '| 策略 | 每小局净分 (95% CI) | 比赛胜率 | 被飞率 | 胡牌率 | 放炮率 | 自摸占比 | 均 W | 均收入 | 均赔付 | 开门率 | 均自身倍率 |'
    : '| 策略 | 每小局净分 (95% CI) | 胡牌率 | 放炮率 | 自摸占比 | 均 W | 均收入 | 均赔付 | 开门率 | 均自身倍率 |';
  lines.push(head);
  lines.push('|' + ' :---: |'.repeat(head.split('|').length - 2));
  for (const n of names) {
    const s = stats[n];
    const ci = bootstrapCI(blockPoints, n);
    const f = (x, d = 1) => x.toFixed(d);
    const cell = `**${f(ci.mean, 2)}** [${f(ci.lo, 2)}, ${f(ci.hi, 2)}]`;
    const common = [
      `${f(s.wins / s.rounds * 100)}% (${s.wins})`,
      `${f(s.dealIns / s.rounds * 100)}%`,
      s.wins ? `${f(s.selfDraws / s.wins * 100)}%` : '—',
      s.wins ? f(s.wSum / s.wins) : '—',
      s.wins ? f(s.gainSum / s.wins) : '—',
      s.payEvents ? f(s.paidSum / s.payEvents) : '—',
      `${f(s.openRounds / s.rounds * 100)}%`,
      f(s.liabilitySum / s.rounds),
    ];
    const extra = mode === 'bust'
      ? [`${f(s.matchWins / s.matches * 100)}%`, `${f(s.busted / s.matches * 100)}%`]
      : [];
    lines.push(`| **${n}** | ${cell} | ${[...extra, ...common].join(' | ')} |`);
  }
  return lines.join('\n');
}

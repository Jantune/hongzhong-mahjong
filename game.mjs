/*
 * 红中赖子杠（七皮四赖）规则引擎。
 *
 * The table state keeps physical tile ids (0..135).  The scoring module
 * receives tile kinds (0..33), so UI actions cannot accidentally duplicate a
 * physical tile while evaluating a hand.
 */

export const NAMES = [
  '一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万',
  '一条', '二条', '三条', '四条', '五条', '六条', '七条', '八条', '九条',
  '一筒', '二筒', '三筒', '四筒', '五筒', '六筒', '七筒', '八筒', '九筒',
  '东', '南', '西', '北', '中', '发', '白',
];

export const TILES = Array.from({ length: 136 }, (_, i) => i);
export const tileType = id => Math.floor(Number(id) / 4);
const clone = value => structuredClone(value);

export function tileName(tile) {
  const n = Number(tile);
  if (!Number.isInteger(n)) return '';
  // Public API historically accepted kinds. Physical ids >= 34 are
  // unambiguous; ids below 34 are interpreted as kinds for compatibility.
  return NAMES[n >= 34 ? tileType(n) : n] ?? '';
}

const kindOf = value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 34 ? tileType(n) : n;
};
const kindValid = t => Number.isInteger(t) && t >= 0 && t < 34;
const physicalValid = id => Number.isInteger(id) && id >= 0 && id < 136;
export const isSuited = t => t >= 0 && t < 27;
export const isHonor = t => t >= 27;
const rankOf = t => (t % 9) + 1;
const suitOf = t => Math.floor(t / 9);

export const indicatorToJoker = indicator => {
  const t = kindOf(indicator);
  if (t >= 0 && t < 27) return Math.floor(t / 9) * 9 + ((t % 9 + 1) % 9);
  // 东、南、西、北、发、白循环，跳过红中。
  const next = new Map([[27, 28], [28, 29], [29, 30], [30, 32], [31, 32], [32, 33], [33, 27]]);
  return next.get(t) ?? 27;
};

export const isSkin = (state, id) => {
  const t = tileType(id);
  return t === state.indicatorType || t === 31;
};
export const isJoker = (state, id) => tileType(id) === state.joker;
const wallCount = state => Array.isArray(state.wall) ? state.wall.length : Number(state.wall) || 0;

const rng = seed => {
  let x = (Number(seed) | 0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
};

function shuffle(array, random) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function emptyResponses(except) {
  return Object.fromEntries([0, 1, 2, 3].filter(p => p !== except).map(p => [p, undefined]));
}

function playerStats(state) {
  return state.melds.map((melds, player) => ({
    open: melds.some(m => !!m.open),
    kongCount: melds.filter(m => m.kind === 'kong').length
      + state.specialKongs[player].filter(k => k.kind === 'skin').length,
    jokerKongCount: state.specialKongs[player].filter(k => k.kind === 'joker').length,
  }));
}

function scoringInput(state, player, event = {}) {
  const hand = state.hands[player].map(tileType);
  if (event.tile !== undefined && !state.hands[player].includes(event.tile)) hand.push(tileType(event.tile));
  return {
    hand,
    melds: state.melds[player].map(m => ({
      kind: m.kind,
      tiles: m.tiles.map(tileType),
      open: !!m.open,
      kongType: m.kongType,
    })),
    specialKongs: state.specialKongs[player].map(k => ({ kind: k.kind, tile: tileType(k.tile) })),
    indicator: state.indicatorType,
    joker: state.joker,
    cap: state.rules.cap,
    selfDraw: !!event.selfDraw,
    from: event.from ?? null,
    winner: player,
    players: playerStats(state),
    gangKai: !!event.gangKai,
    haidi: !!event.haidi,
    robKong: !!event.robKong,
  };
}

import { evaluateHand } from './scoring.mjs';

export function evaluateWin(state, player, event = {}) {
  if (!state || !state.hands?.[player]) return null;
  if (state.hands[player].some(id => isSkin(state, id))) return null;
  if (event.tile !== undefined && isSkin(state, event.tile)) return null;
  const input = scoringInput(state, player, event);
  return evaluateHand(input);
}

function draw(state, player, { gangKai = false } = {}) {
  if (!wallCount(state)) {
    state.phase = 'done';
    state.pending = null;
    state.result = { type: 'draw', winner: null, deltas: [0, 0, 0, 0], scores: [...state.scores], reason: 'wall' };
    state.log.push({ type: 'draw', reason: 'wall' });
    return false;
  }
  // 正常摸牌从牌墙头部取。
  // 杠后补牌借鉴日麻：从王牌取一张，再把牌墙尾部一张挪进王牌，使王牌张数恒定。
  // 对 state.wall 的净效果与旧实现一致（尾部少一张），所以每杠一次可摸牌就少一张。
  let id;
  if (gangKai) {
    if (Array.isArray(state.deadWall) && state.deadWall.length) {
      id = state.deadWall.shift();
      state.deadWall.push(state.wall.pop());
    } else {
      // 没有王牌的状态（手工构造的测试局面、旧版存档）退回原来的"从牌尾补"。
      id = state.wall.pop();
    }
  } else {
    id = state.wall.shift();
  }
  state.hands[player].push(id);
  state.lastDraw = id;
  state.lastDrawPlayer = player;
  state.lastDrawWallRemaining = state.wall.length;
  state.lastDrawHaidi = state.wall.length <= 4;
  state.gangKai = !!gangKai;
  state.turn = player;
  state.canSelfKong[player] = true;
  return true;
}

/**
 * 王牌（不可摸的牌）总张数，含那张翻开的指示牌。
 *
 * 借鉴日麻：日麻王牌固定 14 张 = 4 张岭上补牌 + 5 张表宝牌指示位 + 5 张里宝牌位，
 * 牌墙 84 张里有 14 张永远打不出来。本游戏只翻一张指示牌、没有里宝牌、也没有
 * 杠后再翻，所以那 10 个指示位用不上；这里保留同样的"永久留存"比例（14/83，
 * 与日麻的 14/84 基本一致），其中 1 张是指示牌，其余 13 张纯作岭上补牌区。
 *
 * 注意：王牌张数**不限制**能开几个杠——每次补牌都会从牌墙尾部回补一张，王牌
 * 数量恒定。它唯一的作用是把这些牌永久排除在牌局之外，从而缩短牌局、让"山吞"
 * （想要的牌被王牌吃掉）成为可能。改这个数只影响可摸牌数与荒庄早晚。
 */
export const DEAD_WALL_SIZE = 14;

export function createGame({ cap = 50, seed = Date.now(), dealer = 0, scores = [0, 0, 0, 0], round = 1 } = {}) {
  if (Number(cap) < 10 || Number(cap) > 50) throw Error('cap must be 10..50');
  if (!Number.isInteger(dealer) || dealer < 0 || dealer > 3) throw Error('dealer must be 0..3');
  const random = rng(seed);
  const deck = shuffle(TILES.slice(), random);
  const hands = [[], [], [], []];
  for (let i = 0; i < 13; i += 1) for (let p = 0; p < 4; p += 1) hands[p].push(deck.pop());
  hands[dealer].push(deck.pop());
  let indicator = deck.pop();
  while (tileType(indicator) === 31) {
    // Return a red center to a random position in the remaining wall, then
    // expose another tail tile. Inserting strictly before the tail prevents
    // the just-returned physical tile from being exposed again immediately.
    const place = Math.floor(random() * deck.length);
    deck.splice(place, 0, indicator);
    indicator = deck.pop();
  }
  const indicatorType = tileType(indicator);
  // 指示牌之外再留 DEAD_WALL_SIZE-1 张作岭上补牌区，这些牌永远不会被正常摸到。
  const deadWall = deck.splice(-(DEAD_WALL_SIZE - 1));
  const state = {
    version: 3,
    rules: { cap: Number(cap), seed: Number(seed), wallSize: deck.length, deadWallSize: DEAD_WALL_SIZE },
    phase: 'play',
    dealer,
    turn: dealer,
    round,
    hands,
    melds: [[], [], [], []],
    specialKongs: [[], [], [], []],
    discards: [[], [], [], []],
    wall: deck,
    deadWall,
    indicator,
    indicatorType,
    joker: indicatorToJoker(indicatorType),
    pending: null,
    lastDraw: hands[dealer].at(-1),
    lastDrawPlayer: dealer,
    lastDrawWallRemaining: deck.length,
    lastDrawHaidi: false,
    gangKai: false,
    scores: [...scores],
    result: null,
    log: [],
    canSelfKong: [dealer === 0, dealer === 1, dealer === 2, dealer === 3],
  };
  validateState(state);
  return state;
}

export function nextRound(state) {
  if (!state?.result) throw Error('nextRound requires a completed round');
  const dealer = state.result.type === 'draw' || state.result.winner === state.dealer
    ? state.dealer : (state.dealer + 1) % 4;
  return createGame({
    cap: state.rules.cap,
    seed: (Number(state.rules.seed) | 0) + 1,
    dealer,
    scores: state.scores,
    round: state.round + 1,
  });
}

function handIdsOfKind(state, player, t) {
  return state.hands[player].filter(id => tileType(id) === t);
}

function sequenceOptions(state, player, tile) {
  const t = tileType(tile);
  if (t < 0 || t >= 27) return [];
  const base = Math.floor(t / 9) * 9;
  const rank = (t % 9) + 1;
  const out = [];
  for (let start = Math.max(1, rank - 2); start <= Math.min(7, rank); start += 1) {
    const seq = [base + start - 1, base + start, base + start + 1];
    if (!seq.includes(t)) continue;
    const ids = [];
    let possible = true;
    for (const k of seq) {
      if (k === t) continue;
      const id = state.hands[player].find(x => tileType(x) === k && !isSkin(state, x) && !isJoker(state, x));
      if (id === undefined) { possible = false; break; }
      ids.push(id);
    }
    if (possible) out.push({ kind: 'chi', player, tile, tiles: ids, sequence: seq });
  }
  return out;
}

function selfKongActions(state, player) {
  if (!wallCount(state)) return [];
  const out = [];
  const counts = new Map();
  for (const id of state.hands[player]) {
    const t = tileType(id);
    if (!counts.has(t)) counts.set(t, []);
    counts.get(t).push(id);
  }
  for (const [t, ids] of counts) {
    if (t === state.indicatorType || t === 31) {
      for (const id of ids) out.push({ kind: 'skinKong', player, tile: id, tiles: [id] });
    } else if (t === state.joker) {
      for (const id of ids) out.push({ kind: 'jokerKong', player, tile: id, tiles: [id] });
    } else if (ids.length === 4 && state.canSelfKong[player]) {
      out.push({ kind: 'concealedKong', player, tile: ids[0], tiles: [...ids] });
    }
  }
  if (state.canSelfKong[player]) {
    for (let i = 0; i < state.melds[player].length; i += 1) {
      const meld = state.melds[player][i];
      if (meld.kind !== 'pong' || !meld.tiles.length) continue;
      const t = tileType(meld.tiles[0]);
      if (t === state.indicatorType || t === 31 || t === state.joker) continue;
      // 补杠：碰过的刻子，手里有第四张就能补，不限于这一巡刚摸到的那张（早先留着的也行）。
      // canSelfKong 保证是自己摸过牌之后的回合——刚碰完、还没摸牌时不能补。
      for (const id of handIdsOfKind(state, player, t)) out.push({ kind: 'addedKong', player, tile: id, meldIndex: i });
    }
  }
  return out;
}

function reactionActions(state, player) {
  const pending = state.pending;
  if (!pending || pending.responses?.[player] !== undefined || player === pending.from) return [];
  const out = [{ kind: 'pass', player }];
  const tile = pending.tile;
  const t = tileType(tile);
  if (t === state.indicatorType || t === 31 || t === state.joker) return out;
  const same = handIdsOfKind(state, player, t);
  if (evaluateWin(state, player, { tile, from: pending.from })) out.push({ kind: 'win', player, tile });
  if (same.length >= 3 && wallCount(state)) out.push({ kind: 'exposedKong', player, tile, tiles: same.slice(0, 3) });
  if (same.length >= 2) out.push({ kind: 'pong', player, tile, tiles: same.slice(0, 2) });
  if (player === (pending.from + 1) % 4) out.push(...sequenceOptions(state, player, tile));
  return out;
}

function selfActions(state, player) {
  if (state.turn !== player) return [];
  const out = [];
  const hasDrawn = state.canSelfKong[player] && state.lastDrawPlayer === player;
  const event = { selfDraw: hasDrawn, haidi: hasDrawn && state.lastDrawHaidi, gangKai: hasDrawn && state.gangKai };
  if (hasDrawn && evaluateWin(state, player, event)) out.push({ kind: 'win', player });
  out.push(...selfKongActions(state, player));
  for (const id of state.hands[player]) if (tileType(id) !== state.indicatorType && tileType(id) !== 31) out.push({ kind: 'discard', player, tile: id });
  return out;
}

export function legalActions(state, player = state?.turn) {
  if (!state || state.phase === 'done' || !Number.isInteger(player) || player < 0 || player > 3) return [];
  if (state.pending) return reactionActions(state, player);
  return selfActions(state, player);
}

function samePhysicalSet(a = [], b = []) {
  return [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
}

function matchesAction(legal, action) {
  if (!legal || legal.kind !== action.kind || legal.player !== action.player) return false;
  if (legal.tile !== undefined && action.tile !== legal.tile) return false;
  if (legal.meldIndex !== undefined && action.meldIndex !== legal.meldIndex) return false;
  if (legal.tiles && action.tiles && !samePhysicalSet(legal.tiles, action.tiles)) return false;
  if (legal.tiles && !action.tiles && legal.kind === 'chi') return false;
  return true;
}

function dealerOrder(state, players) {
  return [...players].sort((a, b) => ((a - state.dealer + 4) % 4) - ((b - state.dealer + 4) % 4));
}

function settleWin(state, player, event) {
  const score = evaluateWin(state, player, event);
  if (!score) throw Error('invalid win');
  const payments = Array.isArray(score.payments) ? score.payments.map(Number) : [0, 0, 0, 0];
  while (payments.length < 4) payments.push(0);
  payments[player] = 0;
  const total = payments.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  const deltas = payments.map((value, p) => p === player ? total : -value);
  state.scores = state.scores.map((scoreValue, p) => scoreValue + deltas[p]);
  state.phase = 'done';
  state.pending = null;
  state.turn = player;
  state.gangKai = false;
  state.result = {
    type: 'win', winner: player, from: event.from ?? null, tile: event.tile ?? null,
    score: { ...score, payments, total }, deltas, scores: [...state.scores],
  };
  state.log.push({ type: 'win', player, from: event.from ?? null, labels: score.labels ?? [] });
  return state;
}

function finish(state, player, event = {}) {
  if (event.tile !== undefined && !state.hands[player].includes(event.tile)) state.hands[player].push(event.tile);
  return settleWin(state, player, event);
}

function beginDiscard(state, player, tile) {
  const index = state.hands[player].indexOf(tile);
  if (index < 0 || tileType(tile) === state.indicatorType || tileType(tile) === 31) throw Error('invalid discard');
  state.hands[player].splice(index, 1);
  state.discards[player].push(tile);
  state.pending = { kind: 'discard', from: player, tile, responses: emptyResponses(player) };
  state.phase = 'reaction';
  state.turn = (player + 1) % 4;
  state.canSelfKong[player] = false;
  state.gangKai = false;
  state.log.push({ type: 'discard', player, tile });
  return state;
}

function claimDiscard(state, response) {
  const pending = state.pending;
  const player = response.player;
  const tile = pending.tile;
  const source = pending.from;
  const ids = response.tiles?.length
    ? response.tiles
    : state.hands[player].filter(id => tileType(id) === tileType(tile)).slice(0, response.kind === 'exposedKong' ? 3 : 2);
  for (const id of ids) {
    const index = state.hands[player].indexOf(id);
    if (index < 0) throw Error('claim tile missing');
    state.hands[player].splice(index, 1);
  }
  const sourceDiscard = state.discards[source].pop();
  if (sourceDiscard !== tile) throw Error('discard history mismatch');
  if (response.kind === 'pong') {
    state.melds[player].push({ kind: 'pong', tiles: [tile, ...ids], open: true });
    state.pending = null;
    state.phase = 'play';
    state.turn = player;
    state.canSelfKong[player] = false;
    state.gangKai = false;
    state.log.push({ type: 'pong', player, tile, from: source });
    return state;
  }
  if (response.kind === 'chi') {
    state.melds[player].push({ kind: 'chi', tiles: [tile, ...ids], open: true, sequence: response.sequence });
    state.pending = null;
    state.phase = 'play';
    state.turn = player;
    state.canSelfKong[player] = false;
    state.gangKai = false;
    state.log.push({ type: 'chi', player, tile, from: source, tiles: [...ids] });
    return state;
  }
  if (response.kind === 'exposedKong') {
    state.melds[player].push({ kind: 'kong', tiles: [tile, ...ids], open: true, kongType: 'exposed' });
    state.pending = null;
    state.phase = 'play';
    state.canSelfKong[player] = false;
    state.log.push({ type: 'kong', player, kind: 'exposed', tile, from: source });
    draw(state, player, { gangKai: true });
    return state;
  }
  throw Error('unknown discard claim');
}

function resolveDiscard(state) {
  const pending = state.pending;
  const responses = Object.entries(pending.responses)
    .filter(([, response]) => response && response.kind !== 'pass')
    .map(([p, response]) => ({ player: Number(p), response }));
  const wins = responses.filter(x => x.response.kind === 'win');
  if (wins.length) {
    const winner = dealerOrder(state, wins.map(x => x.player))[0];
    state.discards[pending.from].pop();
    return finish(state, winner, { tile: pending.tile, from: pending.from });
  }
  const claims = responses.filter(x => ['exposedKong', 'pong'].includes(x.response.kind));
  if (claims.length) {
    const chosen = dealerOrder(state, claims.map(x => x.player))[0];
    return claimDiscard(state, claims.find(x => x.player === chosen).response);
  }
  const chi = responses.find(x => x.player === (pending.from + 1) % 4 && x.response.kind === 'chi');
  if (chi) return claimDiscard(state, chi.response);
  state.pending = null;
  state.phase = 'play';
  draw(state, (pending.from + 1) % 4, { gangKai: false });
  return state;
}

function applySelfKong(state, action) {
  const p = action.player;
  if (action.kind === 'addedKong') {
    const meld = state.melds[p][action.meldIndex];
    const index = state.hands[p].indexOf(action.tile);
    if (!meld || meld.kind !== 'pong' || index < 0
      || !state.canSelfKong[p] || tileType(action.tile) !== tileType(meld.tiles[0])) throw Error('invalid added kong');
    state.hands[p].splice(index, 1);
    meld.kind = 'kong';
    meld.tiles.push(action.tile);
    meld.open = true;
    meld.kongType = 'added';
    state.canSelfKong[p] = false;
    state.log.push({ type: 'kong', player: p, kind: 'added', tile: action.tile });
    draw(state, p, { gangKai: true });
    return state;
  }
  if (action.kind === 'concealedKong') {
    const ids = action.tiles?.length ? action.tiles : handIdsOfKind(state, p, tileType(action.tile)).slice(0, 4);
    if (ids.length !== 4 || ids.some(id => !state.hands[p].includes(id))) throw Error('invalid concealed kong');
    state.hands[p] = state.hands[p].filter(id => !ids.includes(id));
    state.melds[p].push({ kind: 'kong', tiles: [...ids], open: false, kongType: 'concealed' });
    state.canSelfKong[p] = false;
    state.log.push({ type: 'kong', player: p, kind: 'concealed', tile: ids[0] });
    draw(state, p, { gangKai: true });
    return state;
  }
  if (action.kind === 'skinKong' || action.kind === 'jokerKong') {
    const index = state.hands[p].indexOf(action.tile);
    if (index < 0) throw Error('invalid special kong');
    state.hands[p].splice(index, 1);
    state.specialKongs[p].push({ kind: action.kind === 'skinKong' ? 'skin' : 'joker', tile: action.tile });
    state.canSelfKong[p] = false;
    state.log.push({ type: 'kong', player: p, kind: action.kind, tile: action.tile });
    draw(state, p, { gangKai: true });
    return state;
  }
  throw Error('unknown self kong');
}

export function applyAction(source, action) {
  if (!action || !Number.isInteger(action.player)) throw Error('action requires player');
  const state = clone(source);
  const legal = legalActions(state, action.player);
  const accepted = legal.find(candidate => matchesAction(candidate, action));
  if (!accepted) throw Error('illegal action');
  const p = action.player;
  if (state.pending) {
    state.pending.responses[p] = accepted.kind === 'pass'
      ? { kind: 'pass', player: p }
      : { ...accepted, ...(action.tiles ? { tiles: [...action.tiles] } : {}) };
    if (Object.values(state.pending.responses).every(response => response !== undefined)) {
      return resolveDiscard(state);
    }
    return state;
  }
  if (accepted.kind === 'win') return finish(state, p, { selfDraw: true, gangKai: state.gangKai, haidi: state.lastDrawPlayer === p && state.lastDrawHaidi });
  if (accepted.kind === 'discard') return beginDiscard(state, p, accepted.tile);
  if (['concealedKong', 'skinKong', 'jokerKong', 'addedKong'].includes(accepted.kind)) return applySelfKong(state, accepted);
  throw Error('unknown action');
}

function sanitizePending(state, seat) {
  if (!state.pending) return null;
  const pending = clone(state.pending);
  for (const [p, response] of Object.entries(pending.responses || {})) {
    if (Number(p) === seat || !response || !response.tiles) continue;
    delete response.tiles;
    delete response.sequence;
  }
  return pending;
}

export function visibleState(state, seat = 0) {
  return {
    version: state.version,
    rules: clone(state.rules),
    phase: state.phase,
    dealer: state.dealer,
    turn: state.turn,
    round: state.round,
    hands: state.hands.map((hand, p) => (p === seat || state.phase === 'done') ? [...hand] : Array(hand.length).fill(null)),
    melds: clone(state.melds),
    specialKongs: clone(state.specialKongs),
    discards: clone(state.discards),
    wall: wallCount(state),
    deadWall: Array.isArray(state.deadWall) ? state.deadWall.length : 0,
    indicator: state.indicator,
    indicatorType: state.indicatorType,
    joker: state.joker,
    pending: sanitizePending(state, seat),
    lastDraw: state.lastDrawPlayer === seat ? state.lastDraw : null,
    lastDrawPlayer: state.lastDrawPlayer,
    lastDrawWallRemaining: state.lastDrawWallRemaining,
    lastDrawHaidi: state.lastDrawHaidi,
    gangKai: state.gangKai && state.lastDrawPlayer === seat,
    canSelfKong: [...state.canSelfKong],
    scores: [...state.scores],
    result: clone(state.result),
    log: clone(state.log),
  };
}

export function tileCounts(hand) {
  const counts = Array(34).fill(0);
  for (const id of hand) counts[tileType(id)] += 1;
  return counts;
}

export function takeTiles(counts, needed, jokers) {
  const next = counts.slice();
  let missing = 0;
  for (const t of needed) {
    if (next[t]) next[t] -= 1;
    else missing += 1;
  }
  return missing <= jokers ? { counts: next, jokers: jokers - missing } : null;
}

export function canMelds(counts, jokers, groups, memo = new Map()) {
  const total = counts.reduce((a, b) => a + b, 0) + jokers;
  if (total !== groups * 3) return false;
  if (groups === 0) return total === 0;
  const key = `${counts.join(',')}|${jokers}|${groups}`;
  if (memo.has(key)) return memo.get(key);
  const first = counts.findIndex(n => n > 0);
  if (first < 0) {
    const answer = jokers === groups * 3;
    memo.set(key, answer);
    return answer;
  }
  // Triplet, with jokers filling the missing copies.
  const triplet = takeTiles(counts, [first, first, first], jokers);
  if (triplet && canMelds(triplet.counts, triplet.jokers, groups - 1, memo)) {
    memo.set(key, true);
    return true;
  }
  // A sequence can start before the first tile when a joker fills its lower
  // end, so test all three possible starts containing the first tile.
  if (first < 27) {
    const rank = first % 9;
    const base = Math.floor(first / 9) * 9;
    for (let offset = 0; offset < 3; offset += 1) {
      const start = rank - offset;
      if (start < 0 || start > 6) continue;
      const sequence = [base + start, base + start + 1, base + start + 2];
      if (!sequence.includes(first)) continue;
      const taken = takeTiles(counts, sequence, jokers);
      if (taken && canMelds(taken.counts, taken.jokers, groups - 1, memo)) {
        memo.set(key, true);
        return true;
      }
    }
  }
  memo.set(key, false);
  return false;
}

export function fastCanWin(state, player, hand) {
  if (hand.some(id => isSkin(state, id))) return false;
  const counts = tileCounts(hand);
  const jokers = counts[state.joker] || 0;
  counts[state.joker] = 0;
  const groups = 4 - state.melds[player].length;
  const expected = groups * 3 + 2;
  if (hand.length !== expected) return false;
  if (groups === 4) {
    const odd = counts.filter(n => n % 2).length;
    if (odd <= jokers && (jokers - odd) % 2 === 0) return true;
  }
  for (let eye = 0; eye < 34; eye += 1) {
    if (!isSuited(eye) || ![2, 5, 8].includes((eye % 9) + 1)) continue;
    const taken = takeTiles(counts, [eye, eye], jokers);
    if (taken && canMelds(taken.counts, taken.jokers, groups)) return true;
  }
  return false;
}

export function fastWaits(state, player, hand) {
  const counts = tileCounts(hand);
  const waits = [];
  for (let t = 0; t < 34; t += 1) {
    if (counts[t] >= 4 || t === state.indicatorType || t === 31) continue;
    if (fastCanWin(state, player, [...hand, t * 4])) waits.push(t);
  }
  return waits;
}

export function shapeScore(state, player, hand) {
  const counts = tileCounts(hand);
  let score = 0;
  for (let t = 0; t < 34; t += 1) {
    const n = counts[t];
    if (!n) continue;
    if (t === state.joker) score += n * 18;
    else if (n >= 3) score += n * 8;
    else if (n === 2) score += 6;
    else if (isHonor(t)) score += 1;
    else score += 2;
    if (isSuited(t)) {
      if (counts[t + 1] && Math.floor((t + 1) / 9) === Math.floor(t / 9)) score += 3;
      if (counts[t + 2] && Math.floor((t + 2) / 9) === Math.floor(t / 9)) score += 1;
    }
  }
  return score - state.melds[player].length * 2;
}

export function discardHeuristic(state, player, actions) {
  const hand = state.hands[player];
  const counts = tileCounts(hand);
  // Removing equivalent physical copies makes the AI decision bounded by the
  // number of kinds in the hand instead of the number of physical tiles.
  const unique = [];
  const seen = new Set();
  for (const action of actions) {
    const t = tileType(action.tile);
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(action);
  }
  const scored = unique.map(action => {
    const next = hand.slice();
    next.splice(next.indexOf(action.tile), 1);
    const waits = fastWaits(state, player, next);
    const t = tileType(action.tile);
    const quality = waits.length * 10000 + shapeScore(state, player, next) - (t === state.joker ? 100 : 0);
    return { action, quality, waits: waits.length };
  });
  scored.sort((a, b) => b.quality - a.quality || tileType(a.action.tile) - tileType(b.action.tile) || a.action.tile - b.action.tile);
  return scored[0]?.action;
}

export function aiChoose(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;
  const win = actions.find(a => a.kind === 'win');
  if (win) return win;
  if (view.pending) {
    const kong = actions.find(a => a.kind === 'exposedKong');
    if (kong) return kong;
    const pong = actions.find(a => a.kind === 'pong');
    if (pong) return pong;
    const chi = actions.find(a => a.kind === 'chi');
    if (chi) return chi;
    return actions.find(a => a.kind === 'pass') || actions[0];
  }
  const kongs = actions.filter(a => ['concealedKong', 'skinKong', 'jokerKong', 'addedKong'].includes(a.kind));
  const special = kongs.find(a => a.kind === 'skinKong');
  if (special) return special;
  // A joker is valuable as a wildcard. Keep a single one for shape quality;
  // when several accumulate, opening one becomes a reasonable exchange for a
  // replacement draw and also exercises the special-kong rule.
  const jokerCount = actions.filter(a => a.kind === 'jokerKong').length;
  if (jokerCount >= 2) return kongs.find(a => a.kind === 'jokerKong');
  const concealed = kongs.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;
  const added = kongs.find(a => a.kind === 'addedKong');
  if (added) return added;
  const discards = actions.filter(a => a.kind === 'discard');
  return discardHeuristic(view, player, discards) || actions[actions.length - 1];
}

export function autoStep(state) {
  if (!state || state.phase === 'done') return state;
  const player = state.pending
    ? Number(Object.keys(state.pending.responses).find(p => state.pending.responses[p] === undefined))
    : state.turn;
  if (!Number.isInteger(player)) return state;
  const action = aiChoose(state, player);
  if (!action) throw Error(`AI has no legal action for player ${player}`);
  return applyAction(state, action);
}

function allStatePhysicalIds(state) {
  const ids = [
    ...state.wall,
    ...(state.deadWall || []),
    state.indicator,
    ...state.hands.flat(),
    ...state.melds.flat().flatMap(m => m.tiles),
    ...state.specialKongs.flat().map(k => k.tile),
    ...state.discards.flat(),
  ];
  return ids;
}

export function validateState(state) {
  if (!state || !Array.isArray(state.wall) || !Array.isArray(state.hands)) throw Error('invalid state');
  if (state.viewFor !== undefined) throw Error('validateState requires a full state');
  if (state.phase === 'reaction' && !state.pending) throw Error('reaction without pending');
  if (state.phase !== 'reaction' && state.pending && state.phase !== 'done') throw Error('pending outside reaction');
  if (state.phase === 'done' && state.pending) throw Error('done with pending');
  for (let p = 0; p < 4; p += 1) {
    if (!Array.isArray(state.hands[p]) || !Array.isArray(state.melds[p]) || !Array.isArray(state.specialKongs[p])) throw Error('player state');
    const conceptual = state.hands[p].length + state.melds[p].length * 3;
    if (![13, 14].includes(conceptual)) throw Error(`bad hand size p${p}: ${conceptual}`);
    for (const meld of state.melds[p]) {
      if (!['chi', 'pong', 'kong'].includes(meld.kind)) throw Error('bad meld kind');
      const wanted = meld.kind === 'kong' ? 4 : 3;
      if (!Array.isArray(meld.tiles) || meld.tiles.length !== wanted) throw Error('bad meld size');
      if (meld.kind !== 'chi' && new Set(meld.tiles.map(tileType)).size !== 1) throw Error('bad triplet');
    }
    for (const kong of state.specialKongs[p]) {
      if (!['skin', 'joker'].includes(kong.kind) || !physicalValid(kong.tile)) throw Error('bad special kong');
      if (kong.kind === 'skin' && !isSkin(state, kong.tile)) throw Error('wrong skin kong');
      if (kong.kind === 'joker' && !isJoker(state, kong.tile)) throw Error('wrong joker kong');
    }
  }
  const conceptualSizes = state.hands.map((hand, p) => hand.length + state.melds[p].length * 3);
  if (state.phase === 'play') {
    for (let p = 0; p < 4; p += 1) {
      const expected = p === state.turn ? 14 : 13;
      if (conceptualSizes[p] !== expected) throw Error(`bad turn hand size p${p}: ${conceptualSizes[p]}`);
    }
  }
  if (state.phase === 'done' && state.result?.type === 'draw' && conceptualSizes.some(size => size !== 13)) {
    throw Error('bad draw hand size');
  }
  if (state.pending) {
    if (state.pending.kind !== 'discard') throw Error('bad pending kind');
    if (Object.keys(state.pending.responses || {}).length !== 3) throw Error('bad response seats');
    if (state.pending.kind === 'discard' && state.discards[state.pending.from].at(-1) !== state.pending.tile) throw Error('pending discard mismatch');
  }
  const ids = allStatePhysicalIds(state);
  if (ids.length !== 136) throw Error(`physical tile count ${ids.length}`);
  if (ids.some(id => !physicalValid(id))) throw Error('invalid physical tile');
  if (new Set(ids).size !== 136) throw Error('duplicate physical tile');
  const counts = Array(34).fill(0);
  ids.forEach(id => { counts[tileType(id)] += 1; });
  if (counts.some(count => count !== 4)) throw Error('tile kind count');
  if (state.result && state.result.deltas.reduce((a, b) => a + b, 0) !== 0) throw Error('non-zero-sum');
  if (state.phase === 'done' && state.result?.type === 'win') {
    for (let p = 0; p < 4; p += 1) {
      const conceptual = state.hands[p].length + state.melds[p].length * 3;
      if (conceptual !== (p === state.result.winner ? 14 : 13)) throw Error('bad winning hand size');
    }
  }
  if (state.phase === 'reaction') {
    for (let p = 0; p < 4; p += 1) {
      if (state.hands[p].length + state.melds[p].length * 3 !== 13) throw Error('bad reaction hand size');
    }
  }
  return true;
}

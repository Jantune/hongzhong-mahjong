const TILE_COUNT = 34;
const HONOR_START = 27;
const RED_CENTER = 31;

const isTile = t => Number.isInteger(t) && t >= 0 && t < TILE_COUNT;
const isSuit = t => isTile(t) && t < 27;
const suit = t => Math.floor(t / 9);
const rank = t => (t % 9) + 1;
const is258 = t => isSuit(t) && [2, 5, 8].includes(rank(t));

const DAHU_NAMES = new Set([
  '碰碰胡', '清一色', '将一色', '风一色', '全求人', '海底捞', '豪华七对', '杠上开花',
]);

function normaliseCap(cap) {
  return Number.isFinite(cap) && cap > 0 ? cap : 50;
}

function tileAllowed(t, mode) {
  if (!isTile(t)) return false;
  if (mode.clean !== null && !(isSuit(t) && suit(t) === mode.clean)) return false;
  if (mode.general && !is258(t)) return false;
  if (mode.wind && t < HONOR_START) return false;
  return true;
}

function isForbiddenNatural(t, skin, joker) {
  return skin.has(t) || t === joker;
}

/* Validate and classify the four ordinary melds.  A joker or a skin may only
 * appear in specialKongs; accepting one here would let it be eaten/ponged. */
function groupsOK(melds, mode, skin, joker) {
  if (!Array.isArray(melds) || melds.length > 4) return false;
  for (const m of melds) {
    if (!m || !['chi', 'pong', 'kong'].includes(m.kind) || !Array.isArray(m.tiles)) return false;
    const ts = m.tiles;
    if (!ts.every(isTile) || ts.some(t => isForbiddenNatural(t, skin, joker))) return false;
    if (m.kind === 'chi') {
      if (mode.pong || ts.length !== 3 || new Set(ts).size !== 3 || !ts.every(isSuit)) return false;
      const a = [...ts].sort((x, y) => x - y);
      if (!(suit(a[0]) === suit(a[1]) && suit(a[1]) === suit(a[2]) &&
        a[1] === a[0] + 1 && a[2] === a[1] + 1)) return false;
    } else {
      if ((m.kind === 'pong' && ts.length !== 3) || (m.kind === 'kong' && ts.length !== 4)) return false;
      if (new Set(ts).size !== 1) return false;
    }
    if (!ts.every(t => tileAllowed(t, mode))) return false;
  }
  return true;
}

function readSpecialTile(k) {
  if (!k || typeof k !== 'object') return null;
  if (isTile(k.tile)) return k.tile;
  if (Array.isArray(k.tiles) && isTile(k.tiles[0])) return k.tiles[0];
  return null;
}

function normaliseSpecialKongs(specialKongs, skin, joker) {
  if (!Array.isArray(specialKongs)) return null;
  const out = [];
  const skinRows = new Map();
  let jokerKongs = 0;
  for (const raw of specialKongs) {
    const rawKind = raw?.kind;
    const kind = rawKind === 'skinKong' ? 'skin' : rawKind === 'jokerKong' ? 'joker' : rawKind;
    const tile = readSpecialTile(raw);
    if (!['skin', 'joker'].includes(kind) || tile === null) return null;
    if (kind === 'skin') {
      if (!skin.has(tile)) return null;
      const count = (skinRows.get(tile) || 0) + 1;
      if (count > 4) return null;
      skinRows.set(tile, count);
      // Each record represents one legal single-card skin kong, including
      // repeated records for the four physical copies of one skin type.
      out.push({ kind: 'skin', tile, rows: 1 });
    } else {
      if (tile !== joker) return null;
      jokerKongs += 1;
    }
  }
  for (let i = 0; i < jokerKongs; i++) out.push({ kind: 'joker', tile: joker, rows: 1 });
  return { list: out, skinGroups: out.filter(k => k.kind === 'skin').length, jokerKongs };
}

function countTypes(hand) {
  const counts = Array(TILE_COUNT).fill(0);
  for (const t of hand) {
    if (!isTile(t) || ++counts[t] > 4) return null;
  }
  return counts;
}

function addMeldCounts(counts, melds) {
  const out = counts.slice();
  for (const m of melds) for (const t of m.tiles) {
    if (++out[t] > 4) return null;
  }
  return out;
}

function makeCountsForJokerUse(counts, joker, usedWild) {
  const natural = counts.slice();
  natural[joker] -= usedWild;
  if (natural[joker] < 0) return null;
  return natural;
}

/* Exact standard hand solver.  `jokers` is the number of physical jokers
 * assigned as wildcards; every one must be consumed by a missing requirement.
 * Natural counts contain the other jokers, which must be used as their actual
 * tile.  This is what makes mixed joker allocations and hard restoration
 * precise. */
function solveStandard(counts, jokers, groupsNeeded, mode) {
  if (groupsNeeded < 0) return false;
  const total = counts.reduce((a, b) => a + b, 0) + jokers;
  if (total !== groupsNeeded * 3 + 2) return false;
  for (let t = 0; t < TILE_COUNT; t++) if (counts[t] && !tileAllowed(t, mode)) return false;

  const memo = new Map();
  const allowedTiles = [...Array(TILE_COUNT).keys()].filter(t => tileAllowed(t, mode));
  const eyePossible = allowedTiles.some(t => !mode.eye258 || is258(t));
  const groupPossible = () => {
    if (mode.pong) return allowedTiles.length > 0;
    for (let s = 0; s < 3; s++) for (let start = 1; start <= 7; start++) {
      const req = [s * 9 + start - 1, s * 9 + start, s * 9 + start + 1];
      if (req.every(t => tileAllowed(t, mode))) return true;
    }
    return allowedTiles.length > 0;
  };
  function dfs(c, j, g, eye) {
    const key = `${c.join(',')}|${j}|${g}|${eye ? 1 : 0}`;
    if (memo.has(key)) return memo.get(key);
    const first = c.findIndex(x => x > 0);
    if (first < 0) {
      const need = g * 3 + (eye ? 2 : 0);
      const ok = j === need && (!eye || eyePossible) && (g === 0 || groupPossible());
      memo.set(key, ok);
      return ok;
    }
    const t = first;
    const take = req => {
      const nc = c.slice();
      let missing = 0;
      for (const x of req) {
        if (nc[x] > 0) nc[x] -= 1;
        else missing += 1;
      }
      if (missing > j) return false;
      return dfs(nc, j - missing, g - 1, eye);
    };

    if (eye && (!mode.eye258 || is258(t)) && tileAllowed(t, mode)) {
      const nc = c.slice();
      let missing = 0;
      for (let i = 0; i < 2; i++) {
        if (nc[t] > 0) nc[t] -= 1;
        else missing += 1;
      }
      if (missing <= j && dfs(nc, j - missing, g, false)) {
        memo.set(key, true);
        return true;
      }
    }
    if (g > 0) {
      if (take([t, t, t])) {
        memo.set(key, true);
        return true;
      }
      if (!mode.pong && isSuit(t)) {
        const r = rank(t), s = suit(t);
        for (let start = Math.max(1, r - 2); start <= Math.min(7, r); start++) {
          const req = [s * 9 + start - 1, s * 9 + start, s * 9 + start + 1];
          if (req.includes(t) && req.every(x => tileAllowed(x, mode)) && take(req)) {
            memo.set(key, true);
            return true;
          }
        }
      }
    }
    memo.set(key, false);
    return false;
  }
  return dfs(counts, jokers, groupsNeeded, true);
}

function solvePairs(counts, jokers, mode) {
  if (counts.reduce((a, b) => a + b, 0) + jokers !== 14) return null;
  let odd = 0;
  let naturalQuad = false;
  for (let t = 0; t < TILE_COUNT; t++) {
    if (counts[t] && !tileAllowed(t, mode)) return null;
    if (counts[t] % 2) odd += 1;
    if (counts[t] === 4) naturalQuad = true;
  }
  if (odd > jokers || (jokers - odd) % 2 !== 0) return null;
  return { deluxe: naturalQuad };
}

function playerFactor(player) {
  const p = player || {};
  const open = p.open ? 2 : 1;
  const kongs = Number.isInteger(p.kongCount) && p.kongCount > 0 ? p.kongCount : 0;
  const jokerKongs = Number.isInteger(p.jokerKongCount) && p.jokerKongCount > 0 ? p.jokerKongCount : 0;
  return { open: !!p.open, multiplier: open * (2 ** kongs) * (4 ** jokerKongs) };
}

function settle({ W, big = false, sevenPairs = false, winner = 0, selfDraw = false,
  from = null, players = [], cap = 50 } = {}) {
  const payments = [0, 0, 0, 0];
  const C = normaliseCap(cap);
  const payAll = !!selfDraw || !!big || !!sevenPairs;
  const payers = payAll
    ? [0, 1, 2, 3].filter(p => p !== winner)
    : (Number.isInteger(from) && from >= 0 && from < 4 && from !== winner ? [from] : []);
  // 金顶：只有三家付款的局面（自摸、七对、大胡）且胡家自身倍数达到封顶才算，
  // 此时未开口的付款者在顶外另付半顶。点炮屁胡只有点炮者一家付，倍数再高也不是金顶。
  const goldTop = payAll && W >= C;
  for (const p of payers) {
    const pf = playerFactor(players[p]);
    const raw = W * pf.multiplier;
    if (raw < 4) continue;
    payments[p] = Math.min(C, raw) + (goldTop && !pf.open ? C / 2 : 0);
  }
  return { payments, total: payments.reduce((a, b) => a + b, 0) };
}

function evaluateHand(input = {}) {
  const {
    hand = [], melds = [], specialKongs = [], indicator, joker, cap = 50,
    selfDraw = false, from = null, winner = 0, players = [], gangKai = false,
    haidi = false, robKong = false,
  } = input;
  if (!Array.isArray(hand) || !Array.isArray(melds) || !Array.isArray(specialKongs)) return null;
  if (!isTile(indicator) || indicator === RED_CENTER || !isTile(joker) || joker === RED_CENTER || joker === indicator) return null;
  if (!Number.isInteger(winner) || winner < 0 || winner > 3) return null;

  const skin = new Set([indicator, RED_CENTER]);
  if (hand.some(t => skin.has(t))) return null;
  const counts = countTypes(hand);
  if (!counts) return null;
  const special = normaliseSpecialKongs(specialKongs, skin, joker);
  if (!special) return null;
  if (!groupsOK(melds, { pong: false, clean: null, general: false, wind: false }, skin, joker)) return null;
  const physicalCounts = counts.slice();
  if (++physicalCounts[indicator] > 4) return null;
  const withMelds = addMeldCounts(physicalCounts, melds);
  if (!withMelds) return null;
  for (const k of special.list) if (++withMelds[k.tile] > 4) return null;

  const baseHandLength = (4 - melds.length) * 3 + 2;
  if (hand.length !== baseHandLength) return null;

  const physicalJokers = counts[joker] || 0;
  const gangKaiSelf = gangKai && selfDraw;
  // 触发杠上开花的那个杠照常计番：杠上开花本身 x4，再乘上那个杠——
  // 普通杠/皮杠 x2 合计 x8，赖杠 x4 合计 x16。
  const ownKongs = melds.filter(m => m.kind === 'kong').length + special.skinGroups;
  const jokerKongs = special.jokerKongs;
  const fullRequester = melds.length === 4 && melds.every(m => !!m.open) && !selfDraw &&
    Number.isInteger(from) && from !== winner;

  const modes = [];
  for (const sevenPairs of [false, true]) {
    for (const pong of [false, true]) {
      for (const clean of [null, 0, 1, 2]) {
        for (const general of [false, true]) {
          for (const wind of [false, true]) {
            if (general && wind) continue;
            if (sevenPairs && (pong || melds.length)) continue;
            // 杠上开花是个例外：它按大胡计倍数与付款范围，但**将牌仍须 2/5/8**，
            // 不像海底捞那样免除。所以这里不能把 gangKaiSelf 加进来。
            const eye258 = !sevenPairs && !pong && clean === null && !general && !wind &&
              !fullRequester && !(haidi && selfDraw) && !robKong;
            modes.push({ sevenPairs, pong, clean, general, wind, eye258 });
          }
        }
      }
    }
  }

  const candidates = [];
  for (const mode of modes) {
    if (!groupsOK(melds, mode, skin, joker)) continue;
    const groupsNeeded = 4 - melds.length;
    for (let usedWild = 0; usedWild <= physicalJokers; usedWild++) {
      const natural = makeCountsForJokerUse(counts, joker, usedWild);
      if (!natural) continue;
      const solution = mode.sevenPairs
        ? solvePairs(natural, usedWild, mode)
        : solveStandard(natural, usedWild, groupsNeeded, mode);
      if (!solution) continue;

      const labels = [];
      if (mode.sevenPairs) labels.push(solution.deluxe ? '豪华七对' : '七对');
      if (mode.pong) labels.push('碰碰胡');
      if (mode.clean !== null) labels.push('清一色');
      if (mode.general) labels.push('将一色');
      if (mode.wind) labels.push('风一色');
      if (fullRequester) labels.push('全求人');
      if (haidi && selfDraw) labels.push('海底捞');
      if (!labels.length) labels.push('屁胡');

      const factors = labels.map(name => ({
        name,
        multiplier: name === '七对' ? 4 : name === '屁胡' ? 1 : 8,
      }));
      const hard = usedWild === 0;
      let W = factors.reduce((a, f) => a * f.multiplier, 1);
      if (hard) {
        W *= 2;
        factors.push({ name: '硬胡', multiplier: 2 });
      }
      for (let i = 0; i < ownKongs; i++) {
        W *= 2;
        factors.push({ name: '杠', multiplier: 2 });
      }
      for (let i = 0; i < jokerKongs; i++) {
        W *= 4;
        factors.push({ name: '赖杠', multiplier: 4 });
      }
      if (gangKaiSelf) {
        // 杠上开花算大胡：自身 x4，三家付，将牌与赖子张数都不限。
        // 触发它的那个杠在上面已经照常乘过了，所以普通杠/皮杠合计 x8、赖杠合计 x16。
        W *= 4;
        factors.push({ name: '杠上开花', multiplier: 4 });
        labels.push('杠上开花');
      }

      const big = labels.some(name => DAHU_NAMES.has(name));
      // 两赖禁屁胡：手持两张及以上赖子不能胡屁胡，胡家自身倍数到顶也不解除。
      // 七对与大胡（含杠上开花）不受限，赖子张数不限。
      if (!big && !mode.sevenPairs && physicalJokers > 1) continue;
      // 门前清屁胡（没吃、没碰、没明杠；暗杠、皮杠、赖杠不算开口）不能捉铳，只能自摸。
      // 七对、大胡不受此限。
      if (!big && !mode.sevenPairs && !selfDraw && !players[winner]?.open) continue;

      const payment = settle({ W, big, sevenPairs: mode.sevenPairs, winner, selfDraw, from, players, cap });
      // A legal win must have at least one actual payer reaching four.
      if (payment.total < 4) continue;
      candidates.push({ labels, W, hard, big, sevenPairs: mode.sevenPairs,
        payments: payment.payments, total: payment.total, factors });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.total - a.total || b.W - a.W || Number(b.hard) - Number(a.hard));
  return candidates[0];
}

export { evaluateHand, settle };

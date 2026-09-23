import {
  createGame,
  nextRound,
  applyAction,
  legalActions,
  visibleState,
  tileType,
  tileName,
  isSkin,
  isJoker,
  isSuited,
  isHonor,
  tileCounts,
  takeTiles,
  canMelds,
  fastCanWin,
  fastWaits,
  shapeScore,
  discardHeuristic,
  aiChoose as aiBaseline,
} from './game.mjs';

// ============================================================================
// Helper Utilities for Custom AI Strategies
// ============================================================================

function countPairs(counts, jokerCount) {
  let naturalPairs = 0;
  let naturalTriplets = 0;
  let naturalQuads = 0;
  let singles = 0;
  for (let t = 0; t < 34; t += 1) {
    const c = counts[t];
    if (c === 1) singles += 1;
    else if (c === 2) naturalPairs += 1;
    else if (c === 3) naturalTriplets += 1;
    else if (c === 4) naturalQuads += 1;
  }
  // Total pairs including wildcard pairs
  const totalPairs = naturalPairs + naturalTriplets + naturalQuads * 2 + Math.floor((singles + naturalTriplets) > 0 ? Math.min(jokerCount, singles + naturalTriplets) : jokerCount / 2);
  return { naturalPairs, naturalTriplets, naturalQuads, singles, totalPairs };
}

function getTableVisibleTileCounts(view) {
  const visible = Array(34).fill(0);
  for (let p = 0; p < 4; p += 1) {
    for (const id of view.discards[p]) visible[tileType(id)] += 1;
    for (const m of view.melds[p]) {
      for (const id of m.tiles) visible[tileType(id)] += 1;
    }
    for (const sk of view.specialKongs[p]) {
      visible[tileType(sk.tile)] += 1;
    }
  }
  if (view.indicator !== undefined) visible[tileType(view.indicator)] += 1;
  return visible;
}

function hasHighDangerOpponent(view, player) {
  for (let p = 0; p < 4; p += 1) {
    if (p === player) continue;
    const kongs = (view.specialKongs[p]?.length || 0) +
      (view.melds[p]?.filter(m => m.kind === 'kong').length || 0);
    // 2 or more kongs means multiplier is at least x4 or x8, high threat!
    if (kongs >= 2) return true;
  }
  return false;
}

function safeDiscardEvaluation(view, player, actions) {
  const visible = getTableVisibleTileCounts(view);
  const hand = view.hands[player];
  const unique = [];
  const seen = new Set();
  for (const action of actions) {
    const t = tileType(action.tile);
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(action);
  }

  const scored = unique.map(action => {
    const t = tileType(action.tile);
    const next = hand.slice();
    next.splice(next.indexOf(action.tile), 1);
    const waits = fastWaits(view, player, next);
    const baseQuality = waits.length * 10000 + shapeScore(view, player, next) - (t === view.joker ? 100 : 0);

    let safety = 0;
    const countOnTable = visible[t];
    // A tile already discarded 3 or 4 times is virtually 100% safe
    if (countOnTable >= 3) safety += 5000;
    else if (countOnTable === 2) safety += 2500;
    else if (countOnTable === 1) safety += 800;

    // Honor tiles with at least 1 visible are generally safer
    if (isHonor(t) && countOnTable >= 1) safety += 1200;

    // Dangerous middle tiles (4, 5, 6) with 0 visible are high risk
    if (isSuited(t)) {
      const rank = (t % 9) + 1;
      if ([4, 5, 6].includes(rank) && countOnTable === 0) safety -= 3000;
      else if ([3, 7].includes(rank) && countOnTable === 0) safety -= 1500;
    }

    return { action, quality: baseQuality + safety, waits: waits.length };
  });

  scored.sort((a, b) => b.quality - a.quality || tileType(a.action.tile) - tileType(b.action.tile) || a.action.tile - b.action.tile);
  return scored[0]?.action;
}

// ============================================================================
// Strategy Archetypes
// ============================================================================

/**
 * 1. Greedy Opener (基线AI / 贪心速攻)
 * Eat, pong, kong whenever possible. Maximizes speed and shape, ignores defensive penalty.
 */
export function aiGreedy(state, player) {
  return aiBaseline(state, player);
}

/**
 * 2. Pure Menqian Defender (门清守节 / 纯防守)
 * Never chi or pong. Never exposed kong.
 * Keeps playerFactor at x1 (avoids x2 penalty on losses).
 * Plays safe discards when danger is detected.
 */
export function aiMenqian(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  // Reaction phase: strictly reject all chi, pong, exposedKong
  if (view.pending) {
    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // Turn phase: Kongs that do NOT open the hand (skinKong, concealedKong, jokerKong)
  const kongs = actions.filter(a => ['concealedKong', 'skinKong', 'jokerKong'].includes(a.kind));
  const skin = kongs.find(a => a.kind === 'skinKong');
  if (skin) return skin;

  const jokerCount = actions.filter(a => a.kind === 'jokerKong').length;
  if (jokerCount >= 2) return kongs.find(a => a.kind === 'jokerKong');

  const concealed = kongs.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;

  // Discard phase: check defensive mode
  const discards = actions.filter(a => a.kind === 'discard');
  const danger = hasHighDangerOpponent(view, player) || view.wall <= 22;
  if (danger) {
    return safeDiscardEvaluation(view, player, discards) || discards[0];
  }
  return discardHeuristic(view, player, discards) || discards[0];
}

/**
 * 3. QiDui Specialist (七对专精流 / 大胡强杀)
 * Pursues Seven Pairs (x4/x8, pays 3 even on ron!).
 * Never chi/pong/exposedKong.
 * Never kongs jokers (jokers are wildcards for pairs).
 * Preserves pairs, discards singles.
 */
export function aiQiDui(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  // Reaction: strictly reject eating/ponging
  if (view.pending) {
    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // Kongs: only skin kong (skin tiles cannot form pairs)
  const skin = actions.find(a => a.kind === 'skinKong');
  if (skin) return skin;

  // Discards: tailored for Seven Pairs
  const discards = actions.filter(a => a.kind === 'discard');
  const hand = view.hands[player];
  const counts = tileCounts(hand);
  const joker = view.joker;

  // First priority to discard: isolated single tiles that are not jokers
  const singles = discards.filter(d => {
    const t = tileType(d.tile);
    return t !== joker && counts[t] === 1;
  });

  if (singles.length > 0) {
    // Score singles: isolated honor tiles first, then 1/9, then 2/8, etc.
    singles.sort((a, b) => {
      const ta = tileType(a.tile), tb = tileType(b.tile);
      const scoreTile = t => {
        if (isHonor(t)) return 100;
        const r = (t % 9) + 1;
        if (r === 1 || r === 9) return 80;
        if (r === 2 || r === 8) return 60;
        return 40;
      };
      return scoreTile(tb) - scoreTile(ta);
    });
    return singles[0];
  }

  // If no singles, discard from triplets (keeping a pair for Seven Pairs)
  const triplets = discards.filter(d => {
    const t = tileType(d.tile);
    return t !== joker && counts[t] === 3;
  });
  if (triplets.length > 0) return triplets[0];

  return discardHeuristic(view, player, discards) || discards[0];
}

/**
 * 4. Kong Hunter (狂暴杠精 / 碰碰胡大胡流)
 * Obsessed with kongs: kongs joker even with 1 joker!
 * Takes all exposed kongs and pongs to pursue PengPengHu (x8).
 */
export function aiKongHunter(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  if (view.pending) {
    const exposed = actions.find(a => a.kind === 'exposedKong');
    if (exposed) return exposed;
    const pong = actions.find(a => a.kind === 'pong');
    if (pong) return pong;
    // Reject chi (chi prevents PengPengHu)
    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // Turn: greedily kong anything
  const skin = actions.find(a => a.kind === 'skinKong');
  if (skin) return skin;

  // Greedily kong single joker!
  const jokerKong = actions.find(a => a.kind === 'jokerKong');
  if (jokerKong) return jokerKong;

  const concealed = actions.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;

  const added = actions.find(a => a.kind === 'addedKong');
  if (added) return added;

  const discards = actions.filter(a => a.kind === 'discard');
  return discardHeuristic(view, player, discards) || discards[0];
}

/**
 * 5. Adaptive Value Optimizer (理智精算流 · 进阶策略)
 * - Value-aware opening: only opens if hand already has kongs or opening enters tenpai / PengPengHu.
 * - Dynamic joker planning: holds for Seven Pairs if pairs >= 4; kongs 1 joker if holding 2 jokers (unblocks Pihu + x4).
 * - Safety defense: shifts to safe discards when opponents show kongs or in late game.
 */
export function aiAdaptiveValue(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  const ownKongs = (view.specialKongs[player]?.length || 0) +
    (view.melds[player]?.filter(m => m.kind === 'kong').length || 0);
  const hand = view.hands[player];
  const counts = tileCounts(hand);
  const jokers = counts[view.joker] || 0;
  counts[view.joker] = 0;
  const pairStats = countPairs(counts, jokers);

  // 1. Pending reactions
  if (view.pending) {
    const exposed = actions.find(a => a.kind === 'exposedKong');
    if (exposed) return exposed;

    const pong = actions.find(a => a.kind === 'pong');
    if (pong) {
      // If we are committed to Seven Pairs (>= 4 pairs), do NOT pong!
      if (pairStats.totalPairs >= 4 && view.melds[player].length === 0) {
        return actions.find(a => a.kind === 'pass') || actions[0];
      }
      // If hand already has kongs (high value), or has 3+ pairs/triplets (PengPengHu path)
      if (ownKongs >= 1 || pairStats.naturalPairs + pairStats.naturalTriplets >= 3) {
        return pong;
      }
      // Otherwise pass to avoid x2 penalty on defense!
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    const chi = actions.find(a => a.kind === 'chi');
    if (chi) {
      // Never chi if pursuing Seven Pairs
      if (pairStats.totalPairs >= 4 && view.melds[player].length === 0) {
        return actions.find(a => a.kind === 'pass') || actions[0];
      }
      // Only chi if we already have kongs (so we can win and hit hard), AND it gets us close to tenpai
      if (ownKongs >= 1) {
        return chi;
      }
      // Otherwise keep closed!
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // 2. Turn kongs
  const skin = actions.find(a => a.kind === 'skinKong');
  if (skin) return skin;

  const concealed = actions.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;

  const added = actions.find(a => a.kind === 'addedKong');
  if (added) return added;

  // Joker Kong decision:
  const jokerKongs = actions.filter(a => a.kind === 'jokerKong');
  if (jokerKongs.length > 0) {
    // If pursuing Seven Pairs (>= 4 pairs and no melds), keep jokers!
    if (pairStats.totalPairs >= 4 && view.melds[player].length === 0) {
      // Do not kong joker, use as pair wildcard!
    } else if (jokerKongs.length >= 2) {
      // Holding 2 jokers blocks Pihu in Wuhan Mahjong! Must kong 1 to unblock and get x4
      return jokerKongs[0];
    } else if (jokerKongs.length === 1 && ownKongs >= 1 && view.wall > 25) {
      // Konging single joker when already having 1 kong jumps multiplier to x8!
      return jokerKongs[0];
    }
  }

  // 3. Discard logic
  const discards = actions.filter(a => a.kind === 'discard');
  const waits = fastWaits(view, player, hand);
  const isTenpai = waits.length > 0;

  // If in Tenpai, maintain tenpai and maximize winning waits
  if (isTenpai) {
    return discardHeuristic(view, player, discards) || discards[0];
  }

  // If not tenpai, evaluate danger
  const highDanger = hasHighDangerOpponent(view, player) || view.wall <= 20;
  if (highDanger) {
    return safeDiscardEvaluation(view, player, discards) || discards[0];
  }

  // If pursuing Seven Pairs
  if (pairStats.totalPairs >= 4 && view.melds[player].length === 0) {
    const singles = discards.filter(d => {
      const t = tileType(d.tile);
      return t !== view.joker && counts[t] === 1;
    });
    if (singles.length > 0) {
      singles.sort((a, b) => {
        const ta = tileType(a.tile), tb = tileType(b.tile);
        return (isHonor(tb) ? 100 : 50) - (isHonor(ta) ? 100 : 50);
      });
    }
  }

  return discardHeuristic(view, player, discards) || discards[0];
}

/**
 * 6. Championship AI (统御大师流 · 进阶进化策略)
 * - Dual-path branching: If opening hand has >= 4 pairs (with jokers), locks into Seven Pairs
 *   to capture the 85+ point three-payer payout without opening.
 * - Dynamic tempo in normal mode:
 *   - Exposed kong is always taken (x2 + replacement draw).
 *   - Pong is taken if hand has >= 3 pairs/triplets (PengPengHu) or already has kongs, or maintains 2/5/8 eye.
 *   - Chi is taken only if hand already has kongs OR has 2/5/8 eye and is close to tenpai (avoids opening dead-end hands).
 * - Golden Joker Management:
 *   - If holding >= 2 jokers in normal mode: kongs 1 joker to unblock Pihu + gain permanent x4 Lai Gang!
 *   - If holding 1 joker: preserves it as universal wildcard for lightning speed.
 * - Smart tactical defense: shifts to high-safety discards when opponents show kongs or in late game (wall <= 20).
 */
export function aiChampionship(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  // 1. Always take win
  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  const hand = view.hands[player];
  const counts = tileCounts(hand);
  const jokers = counts[view.joker] || 0;
  counts[view.joker] = 0;
  const pairStats = countPairs(counts, jokers);
  const ownKongs = (view.specialKongs[player]?.length || 0) +
    (view.melds[player]?.filter(m => m.kind === 'kong').length || 0);
  const isSevenPairsTrack = pairStats.totalPairs >= 4 && view.melds[player].length === 0;

  // Helper: check if hand has potential 2/5/8 eye
  const has258Eye = () => {
    if (jokers > 0) return true;
    for (const t of [1, 4, 7, 10, 13, 16, 19, 22, 25]) { // 2,5,8 ranks
      if (counts[t] >= 2) return true;
    }
    return false;
  };

  // 2. Pending reactions (when another player discarded)
  if (view.pending) {
    // If on Seven Pairs track, strictly pass on all eating/ponging
    if (isSevenPairsTrack) {
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    const exposed = actions.find(a => a.kind === 'exposedKong');
    if (exposed) return exposed;

    const pong = actions.find(a => a.kind === 'pong');
    if (pong) {
      // Pong advances triplets: accept if building PengPengHu or already high value
      if (ownKongs >= 1 || pairStats.naturalPairs + pairStats.naturalTriplets >= 3) {
        return pong;
      }
      // Or if hand has an eye or joker, ponging accelerates into active hand
      if (has258Eye() || jokers >= 1) {
        return pong;
      }
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    const chi = actions.find(a => a.kind === 'chi');
    if (chi) {
      // Chi is selective: accept if already has kongs, or has 2/5/8 eye and good shape
      if (ownKongs >= 1 || ((has258Eye() || jokers >= 1) && view.wall < 60)) {
        return chi;
      }
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // 3. Turn action: Special Kongs & Ordinary Kongs
  const skin = actions.find(a => a.kind === 'skinKong');
  if (skin) return skin;

  const concealed = actions.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;

  const added = actions.find(a => a.kind === 'addedKong');
  if (added) return added;

  // Joker Kong decision
  const jokerKongs = actions.filter(a => a.kind === 'jokerKong');
  if (jokerKongs.length > 0) {
    if (isSevenPairsTrack) {
      // Preserve jokers for 7 pairs!
    } else if (jokerKongs.length >= 2) {
      // 2 jokers blocks Pihu in Wuhan Mahjong! Kong 1 to unblock and secure x4
      return jokerKongs[0];
    } else if (jokerKongs.length === 1 && ownKongs >= 1 && view.wall > 25) {
      // Konging turns x2 into x8, huge expected payoff!
      return jokerKongs[0];
    }
  }

  // 4. Discard phase
  const discards = actions.filter(a => a.kind === 'discard');
  if (!discards.length) return actions[actions.length - 1];

  // If on Seven Pairs track
  if (isSevenPairsTrack) {
    const singles = discards.filter(d => {
      const t = tileType(d.tile);
      return t !== view.joker && counts[t] === 1;
    });
    if (singles.length > 0) {
      // In danger mode, discard safe singles first
      const danger = hasHighDangerOpponent(view, player) || view.wall <= 20;
      if (danger) {
        return safeDiscardEvaluation(view, player, singles) || singles[0];
      }
      singles.sort((a, b) => {
        const ta = tileType(a.tile), tb = tileType(b.tile);
        return (isHonor(tb) ? 100 : 50) - (isHonor(ta) ? 100 : 50);
      });
      return singles[0];
    }
    // If no singles, discard 1 tile from triplets
    const triplets = discards.filter(d => tileType(d.tile) !== view.joker && counts[tileType(d.tile)] === 3);
    if (triplets.length > 0) return triplets[0];
  }

  // Normal mode:
  const waits = fastWaits(view, player, hand);
  const isTenpai = waits.length > 0;
  if (isTenpai) {
    return discardHeuristic(view, player, discards) || discards[0];
  }

  // Not tenpai: check defense
  const danger = hasHighDangerOpponent(view, player) || view.wall <= 20;
  if (danger) {
    return safeDiscardEvaluation(view, player, discards) || discards[0];
  }

  return discardHeuristic(view, player, discards) || discards[0];
}

/**
 * 7. Predator AI (极速掠食流 · 调优终极策略)
 * - Retains Greedy's ultra-fast opening tempo (eat, pong, exposed kong to cycle turns and lock in groups).
 * - Eye Protection: Does NOT chi using a 2/5/8 tile if it is the hand's ONLY remaining 2/5/8 tile and hand has 0 jokers (prevents dead-end Pihu).
 * - Ultra-Fast Seven Pairs: ONLY commits to Seven Pairs if starting with >= 5 pairs (counting jokers), ensuring it's 1-2 draws away from winning.
 * - Selective Danger Defense: If NOT in Tenpai and an opponent has >= 2 kongs (danger alert), avoids discarding unseen dangerous 4,5,6 middle tiles; drops visible/safe tiles instead.
 * - Kong Precision: Kongs 1 joker if holding >= 2 jokers (unblocks Pihu + permanent x4).
 */
export function aiPredator(state, player) {
  const view = visibleState(state, player);
  const actions = legalActions(view, player);
  if (!actions.length) return null;

  const win = actions.find(a => a.kind === 'win');
  if (win) return win;

  const hand = view.hands[player];
  const counts = tileCounts(hand);
  const jokers = counts[view.joker] || 0;
  counts[view.joker] = 0;
  const pairStats = countPairs(counts, jokers);

  // If extremely close to Seven Pairs (>= 5 pairs including jokers) and no melds yet
  const isSuperQiDui = pairStats.totalPairs >= 5 && view.melds[player].length === 0;

  if (view.pending) {
    if (isSuperQiDui) {
      return actions.find(a => a.kind === 'pass') || actions[0];
    }

    const kong = actions.find(a => a.kind === 'exposedKong');
    if (kong) return kong;

    const pong = actions.find(a => a.kind === 'pong');
    if (pong) return pong;

    const chis = actions.filter(a => a.kind === 'chi');
    if (chis.length > 0) {
      // Pick chi that preserves 2/5/8 eye if we have no jokers
      if (jokers === 0) {
        const eyeTiles = [1, 4, 7, 10, 13, 16, 19, 22, 25];
        const safeChi = chis.find(c => {
          const used = (c.sequence || []).filter(t => t !== tileType(view.pending.tile));
          const rem = counts.slice();
          for (const u of used) rem[u] -= 1;
          return eyeTiles.some(e => rem[e] >= 2);
        });
        if (safeChi) return safeChi;
      }
      return chis[0];
    }

    return actions.find(a => a.kind === 'pass') || actions[0];
  }

  // Turn:
  const kongs = actions.filter(a => ['concealedKong', 'skinKong', 'jokerKong', 'addedKong'].includes(a.kind));
  const special = kongs.find(a => a.kind === 'skinKong');
  if (special) return special;

  const jokerCount = actions.filter(a => a.kind === 'jokerKong').length;
  if (jokerCount >= 2 && !isSuperQiDui) return kongs.find(a => a.kind === 'jokerKong');

  const concealed = kongs.find(a => a.kind === 'concealedKong');
  if (concealed) return concealed;

  const added = kongs.find(a => a.kind === 'addedKong');
  if (added) return added;

  const discards = actions.filter(a => a.kind === 'discard');
  if (!discards.length) return actions[actions.length - 1];

  if (isSuperQiDui) {
    const singles = discards.filter(d => tileType(d.tile) !== view.joker && counts[tileType(d.tile)] === 1);
    if (singles.length > 0) {
      singles.sort((a, b) => (isHonor(tileType(b.tile)) ? 100 : 50) - (isHonor(tileType(a.tile)) ? 100 : 50));
      return singles[0];
    }
  }

  // Check Tenpai
  const waits = fastWaits(view, player, hand);
  if (waits.length > 0) {
    return discardHeuristic(view, player, discards) || discards[0];
  }

  // If not in Tenpai and high danger
  const highDanger = hasHighDangerOpponent(view, player);
  if (highDanger) {
    return safeDiscardEvaluation(view, player, discards) || discards[0];
  }

  return discardHeuristic(view, player, discards) || discards[0];
}

// Map of strategy names to functions
export const STRATEGIES = {
  Greedy: aiGreedy,
  Menqian: aiMenqian,
  QiDui: aiQiDui,
  KongHunter: aiKongHunter,
  AdaptiveValue: aiAdaptiveValue,
  Championship: aiChampionship,
  Predator: aiPredator,
};

// ============================================================================
// Match Simulation Engine (Cap 32, End at <= -300)
// ============================================================================

export function runMatch(policies, { matchId = 1, cap = 32, bustThreshold = -300, maxRounds = 80, seed = 1000 } = {}) {
  let state = createGame({ cap, seed, dealer: 0, scores: [0, 0, 0, 0], round: 1 });
  const roundEvents = [];

  while (!state.scores.some(s => s <= bustThreshold) && state.round <= maxRounds) {
    const startScores = [...state.scores];
    let stepCount = 0;
    const maxSteps = 400;

    while (state.phase !== 'done' && stepCount < maxSteps) {
      const player = state.pending
        ? Number(Object.keys(state.pending.responses).find(p => state.pending.responses[p] === undefined))
        : state.turn;
      if (!Number.isInteger(player)) break;
      const chooseFn = policies[player] || aiBaseline;
      const action = chooseFn(state, player);
      if (!action) break;
      state = applyAction(state, action);
      stepCount += 1;
    }

    if (state.phase === 'done' && state.result) {
      const delta = state.scores.map((s, idx) => s - startScores[idx]);
      roundEvents.push({
        round: state.round,
        dealer: state.dealer,
        resultType: state.result.type,
        winner: state.result.winner,
        labels: state.result.score?.labels || [],
        W: state.result.score?.W || 0,
        payments: state.result.score?.payments || [0, 0, 0, 0],
        totalPayout: state.result.score?.total || 0,
        selfDraw: state.result.from === null,
        from: state.result.from,
        delta,
        endScores: [...state.scores],
      });
    }

    // Check if match end condition reached
    if (state.scores.some(s => s <= bustThreshold)) break;

    // Transition to next round
    if (state.phase === 'done') {
      state = nextRound(state);
    } else {
      break;
    }
  }

  const finalScores = [...state.scores];
  const busted = finalScores.map((s, idx) => ({ player: idx, score: s })).filter(x => x.score <= bustThreshold).map(x => x.player);
  
  // Sort players by final score descending
  const ranking = [0, 1, 2, 3].sort((a, b) => finalScores[b] - finalScores[a]);

  return {
    matchId,
    roundsPlayed: roundEvents.length,
    finalScores,
    ranking,
    winnerPlayer: ranking[0],
    bustedPlayers: busted,
    roundEvents,
  };
}

// ============================================================================
// Tournament Orchestration & Metrics
// ============================================================================

export function runTournament({ lineup, numMatches = 20, seedStart = 1000, cap = 32, bustThreshold = -300 } = {}) {
  const stats = {};
  for (const name of lineup) {
    stats[name] = {
      name,
      matchesPlayed: 0,
      matchWins: 0, // Finished 1st in match
      matchSecond: 0,
      matchThird: 0,
      matchBusted: 0, // Was the one hitting <= -300
      totalFinalScore: 0,
      roundsWon: 0,
      roundsDealtIn: 0, // Point cannon provider
      selfDrawWins: 0,
      dahuWins: 0,
      totalPayoutGained: 0,
      huTypeDistribution: {},
    };
  }

  let totalRoundsAllMatches = 0;
  const matchResults = [];

  for (let m = 0; m < numMatches; m += 1) {
    // Seat rotation: rotate assignment so no strategy has permanent dealer or seating advantage
    const seatNames = [0, 1, 2, 3].map(seat => lineup[(seat + m) % 4]);
    const seatPolicies = seatNames.map(name => STRATEGIES[name]);

    const result = runMatch(seatPolicies, {
      matchId: m + 1,
      cap,
      bustThreshold,
      seed: seedStart + m * 77,
    });

    totalRoundsAllMatches += result.roundsPlayed;
    matchResults.push({
      matchId: m + 1,
      seatNames,
      finalScores: result.finalScores,
      ranking: result.ranking.map(seat => seatNames[seat]),
      busted: result.bustedPlayers.map(seat => seatNames[seat]),
      rounds: result.roundsPlayed,
    });

    // Update match stats
    result.ranking.forEach((seat, rankIdx) => {
      const name = seatNames[seat];
      stats[name].matchesPlayed += 1;
      stats[name].totalFinalScore += result.finalScores[seat];
      if (rankIdx === 0) stats[name].matchWins += 1;
      else if (rankIdx === 1) stats[name].matchSecond += 1;
      else if (rankIdx === 2) stats[name].matchThird += 1;
    });

    for (const bustedSeat of result.bustedPlayers) {
      const name = seatNames[bustedSeat];
      stats[name].matchBusted += 1;
    }

    // Update round stats
    for (const ev of result.roundEvents) {
      if (ev.resultType === 'win' && ev.winner !== null) {
        const winnerName = seatNames[ev.winner];
        stats[winnerName].roundsWon += 1;
        stats[winnerName].totalPayoutGained += ev.totalPayout;
        if (ev.selfDraw) stats[winnerName].selfDrawWins += 1;

        const isDahu = ev.labels.some(l => ['七对', '豪华七对', '碰碰胡', '清一色', '将一色', '风一色', '全求人'].includes(l));
        if (isDahu) stats[winnerName].dahuWins += 1;

        for (const label of ev.labels) {
          stats[winnerName].huTypeDistribution[label] = (stats[winnerName].huTypeDistribution[label] || 0) + 1;
        }

        if (!ev.selfDraw && ev.from !== null && ev.from !== ev.winner) {
          const fromName = seatNames[ev.from];
          stats[fromName].roundsDealtIn += 1;
        }
      }
    }
  }

  return {
    lineup,
    numMatches,
    totalRoundsAllMatches,
    stats,
    matchResults,
  };
}

// ============================================================================
// Formatting & Reporting
// ============================================================================

export function formatTournamentReport(results, title = 'Tournament Results') {
  const { lineup, numMatches, totalRoundsAllMatches, stats } = results;
  const lines = [];
  lines.push(`\n### ${title} (${numMatches} 场完整战局，共 ${totalRoundsAllMatches} 小局，32 封顶 / -300 击溃终局)`);
  lines.push('');
  lines.push('| 策略名称 | 比赛胜率 (第1名) | 击溃被飞率 (≤-300) | 场均净胜分 | 小局胡牌率 | 放炮率 | 自摸占比 | 大胡率 | 平均打点 |');
  lines.push('| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |');

  for (const name of lineup) {
    const s = stats[name];
    const winRate = ((s.matchWins / s.matchesPlayed) * 100).toFixed(1) + '%';
    const bustRate = ((s.matchBusted / s.matchesPlayed) * 100).toFixed(1) + '%';
    const avgScore = (s.totalFinalScore / s.matchesPlayed).toFixed(1);
    const roundWinRate = ((s.roundsWon / totalRoundsAllMatches) * 100).toFixed(1) + '%';
    const dealInRate = ((s.roundsDealtIn / totalRoundsAllMatches) * 100).toFixed(1) + '%';
    const selfDrawPct = s.roundsWon > 0 ? ((s.selfDrawWins / s.roundsWon) * 100).toFixed(1) + '%' : '0.0%';
    const dahuPct = s.roundsWon > 0 ? ((s.dahuWins / s.roundsWon) * 100).toFixed(1) + '%' : '0.0%';
    const avgPayout = s.roundsWon > 0 ? (s.totalPayoutGained / s.roundsWon).toFixed(1) : '0.0';

    lines.push(`| **${name}** | ${winRate} (${s.matchWins}/${s.matchesPlayed}) | ${bustRate} (${s.matchBusted}/${s.matchesPlayed}) | ${avgScore > 0 ? '+' : ''}${avgScore} | ${roundWinRate} (${s.roundsWon}) | ${dealInRate} (${s.roundsDealtIn}) | ${selfDrawPct} | ${dahuPct} | ${avgPayout} 点 |`);
  }

  lines.push('');
  lines.push('#### 胡牌牌型与特殊倍率分布:');
  for (const name of lineup) {
    const s = stats[name];
    const dist = Object.entries(s.huTypeDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}次`)
      .join(', ');
    lines.push(`- **${name}**: ${dist || '无胡牌'}`);
  }

  return lines.join('\n');
}

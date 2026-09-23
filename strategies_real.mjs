// 以真实打法为蓝本的策略集合。
//
// 与 simulate_tournament.mjs 里那批"原型"的根本区别：那批策略靠人为禁令区分彼此
// （绝不吃碰 / 单赖必杠 / 开局锁死七对），本质是稻草人；这里所有策略共享同一套
// 向听—进张—安全度评估，差别只在**风险偏好**这几个可调参数上，就像真实牌手之间
// 的差别一样。
//
// 三条被实测数据钉死的设计前提（见 README 分析）：
//   1. 94% 的和牌是屁胡，而屁胡强制 2/5/8 做将 —— 将眼是最紧的约束。这一点已经
//      内建进向听函数，吃碰后将眼断掉会直接体现为向听数变差，不需要额外补丁。
//   2. 44% 的付款已经打到 32 封顶 —— 继续堆倍数没有边际收益，频率优于打点。
//   3. 输家自身倍率 = 开门(x2) x 2^杠 x 4^赖杠。皮杠是强制的躲不掉，但**开门与
//      自摸杠是自选的**，每一次自选都把整晚的赔付翻倍。基线 AI 无条件全收，这是漏洞。

import { legalActions, visibleState, tileType, discardHeuristic, shapeScore } from './game.mjs';
import {
  handShape, shantenStandard, shantenQidui, shantenPeng,
  ukeire, visibleCounts, dangerOf, maxThreat, ownLiability,
} from './handeval.mjs';



/**
 * 有效向听：三条和牌路线不能等权取 min。
 *
 * 实测 1440 局：屁胡 94.2%、碰碰胡 1.7%、七对 0.4%。七对与碰碰胡的"名义向听"
 * 经常比屁胡低（手上有几个对子，七对就显得很近），但它们的完成率低一个数量级，
 * 而且一旦按它们计数，**任何吃碰都会让向听变差**，策略就再也不鸣牌了——这正是
 * 第一版里 Guarded 每局只鸣 0.32 次、听牌率只有 25% 的原因。
 * 所以给这两条路线加一个折价，让它们只有明显领先时才接管决策。
 */
function bestShanten(counts, jokers, needGroups, opt = {}) {
  const qiduiPen = opt.qiduiPen ?? 1.5;
  const pengPen = opt.pengPen ?? 1.0;
  let best = shantenStandard(counts, jokers, needGroups, true);
  if (needGroups === 4) best = Math.min(best, shantenQidui(counts, jokers, needGroups) + qiduiPen);
  if (!opt.hasChi) best = Math.min(best, shantenPeng(counts, jokers, needGroups) + pengPen);
  return best;
}

/** 14 张形态下，打掉一张之后能达到的最好向听。 */
function shantenAfterBestDiscard(counts, jokers, needGroups, opt) {
  let best = Infinity;
  for (let t = 0; t < 34; t += 1) {
    if (!counts[t]) continue;
    counts[t] -= 1;
    const s = bestShanten(counts, jokers, needGroups, opt);
    counts[t] += 1;
    if (s < best) best = s;
  }
  if (jokers > 0) best = Math.min(best, bestShanten(counts, jokers - 1, needGroups, opt));
  return best === Infinity ? bestShanten(counts, jokers, needGroups, opt) : best;
}

// ---------------------------------------------------------------------------
// 参数化策略
// ---------------------------------------------------------------------------

const DEFAULTS = {
  callNeedsGain: 1,          // 鸣牌要求向听至少改善几步
  callTenpaiOnly: false,     // 是否只在能直接听牌时才鸣
  defense: 0,                // 防守权重（0 = 完全不看安全度）
  foldShanten: 99,           // 向听差于此且威胁够大时弃和
  foldThreat: 3.0,           // 触发弃和的对手威胁阈值
  voluntaryKongShanten: 1,   // 暗杠/补杠只在向听 <= 此值时才开
  jokerKongMin: 2,           // 手上赖子达到几张才开赖杠
  qiduiPen: 1.5,             // 七对路线的折价
  pengPen: 1.0,              // 碰碰胡路线的折价
  tempoBonus: 0,             // 每偷到一个轮次，折算成多少向听的价值
  useEngineDiscard: false,   // 消融用：出牌改用引擎的 discardHeuristic
  pongW: 0.8,                // 可碰的有效牌：一个对家的弃牌折算成多少次自摸机会
  chiW: 0.2,                 // 只能吃上家的顺子搭，同上
  // 进张相对向听的权重。这个数第一版设成 1.0 是个标定错误：uk.tiles*6 实战中是
  // 150~360，而一步向听只值 200，进张项常年压过向听项，策略等于在最大化进张数
  // 而不是最快和牌。同一份代码把它降到 0.3，净分从 -4.08 变成 +2.28。
  // 实测最优区间 0.1~0.3，0.5 已明显变差。
  ukWeight: 0.3,
  shapeW: 0,                 // 引擎 shapeScore 作为结构性平局裁决的权重
  // 进张是否用与出牌排序相同的（带七对/碰碰胡折价的）向听来数。
  // false 为旧口径：排序用折价向听、进张用未折价向听，两把尺子不一致，
  // 会出现"拆对子比打孤张进张多"的误判。见 handeval.mjs 的 ukeire 注释。
  // 复式实测（每小局，修后-修前，块配对 95% CI）：强手同桌 稳健 +1.00 [+0.47, +1.59]、
  // 精算 +1.14 [+0.51, +1.89]；对 3 家基线 稳健 +1.38 [+0.48, +2.34]、精算 +1.11 [+0.10, +2.26]。
  ukConsistent: true,
  // 出牌同分时先打"留着最没用"的牌（见 keepValue），false 则按手牌顺序取第一个
  tieKeep: false,
  // 最后一张皮子留到听牌才杠，搏杠上开花（见 makePolicy 里的特殊杠分支）
  holdLastSkin: false,
  // 配合 holdLastSkin：向听数大于此值时照常马上杠（Infinity = 一直留到听牌）
  holdSkinMaxXt: Infinity,
  // 保命模式（见 effectiveProfile）：null = 不启用
  surviveBelow: null,
  surviveMode: { defense: 2.0, foldShanten: 1, foldThreat: 2.0, callNeedsGain: 2, voluntaryKongShanten: 0 },
};

export const PROFILES = {
  // 牌效实战流：只看进张，不做防守。用来隔离"把吃碰判断做对"本身值多少。
  Efficient: { ...DEFAULTS },
  // 攻守兼备流：真实中上水平牌手的默认形态。
  Guarded: { ...DEFAULTS, defense: 1.0, foldShanten: 2 },
  // 门清倍数流：把"自身倍率"当资产经营，只在能直接听牌时才开门。
  Closed: { ...DEFAULTS, callTenpaiOnly: true, defense: 1.4, foldShanten: 2, voluntaryKongShanten: 0 },
  // 速度流：只要不变差就鸣，全收杠，零防守。这是"贪婪速攻"被正确实现后的样子，
  // 用来公平地检验 README 的核心论断。
  Tempo: { ...DEFAULTS, callNeedsGain: 0, voluntaryKongShanten: 99 },

  // ---- 以下两个是扫参收敛后的成品 ----
  //
  // 极速精算流：见牌就鸣、全收杠、零防守，出牌由"向听为主 + 加权进张为辅"驱动。
  //
  // 加王牌之前它是最强的（对 3 家基线 +2.69）。加王牌之后可摸牌 82→69，巡数变少，
  // 它塌到 -0.15 [-1.60, +1.39]，与基线已无区别；强手同桌 -0.70。
  // 纯速度是这次规则改动的最大输家：推牌能多摸的巡数没了，放炮的代价却没变。
  // 留着它主要是作为"零防守"这一端的对照。
  Apex: {
    ...DEFAULTS,
    callNeedsGain: -99, voluntaryKongShanten: 99, defense: 0,
    pongW: 0.8, chiW: 0.2, ukWeight: 0.3,
  },

  // 稳健流（参数与 Guarded 相同，留作语义别名）。
  // 加王牌之后这一档反超：强手同桌 +1.56 [+1.06, +2.05]，排第一；对 3 家基线 +2.52。
  // 放炮率 13.6%、开门率 68.9% 都是全场最低——牌墙变短以后，防守开始回本。
  Balanced: {
    ...DEFAULTS,
    callNeedsGain: 1, voluntaryKongShanten: 1,
    defense: 1.0, foldShanten: 2, foldThreat: 3.0,
  },
};

/**
 * 保命模式：锦标赛（300 点起、跌破 0 出局）里自己的分数跌到 surviveBelow 以下时，
 * 换成低波动打法——防守更重、更早弃和、少开口（开口让自己输牌时赔付 ×2）、不主动开杠。
 * surviveBelow 为 null 时不启用（非锦标赛的分数从 0 起、常为负，不能用这个判断）。
 */
function effectiveProfile(P, view, player) {
  if (!Number.isFinite(P.surviveBelow) || view.scores[player] >= P.surviveBelow) return P;
  return { ...P, ...P.surviveMode };
}

export function makePolicy(profile) {
  const P0 = typeof profile === 'string' ? PROFILES[profile] : profile;
  if (!P0) throw Error(`unknown profile ${profile}`);

  return function policy(state, player) {
    const view = visibleState(state, player);
    const P = effectiveProfile(P0, view, player);
    const actions = legalActions(view, player);
    if (!actions.length) return null;

    const win = actions.find(a => a.kind === 'win');
    if (win) return win;                      // 4 点门槛已由引擎把关，能胡就胡

    const hand = view.hands[player];
    const { counts, jokers, needGroups } = handShape(view, player, hand);
    const opt = {
      qiduiPen: P.qiduiPen, pengPen: P.pengPen,
      hasChi: view.melds[player].some(m => m.kind === 'chi'),
    };

    // ---- 反应阶段：吃 / 碰 / 明杠 --------------------------------------
    if (view.pending) {
      const pass = actions.find(a => a.kind === 'pass') || actions[0];
      const cur = bestShanten(counts, jokers, needGroups, opt);
      const threat = maxThreat(view, player);
      // 已经在弃和状态就不再开门给自己加倍率
      if (P.defense > 0 && cur > P.foldShanten && threat >= P.foldThreat) return pass;

      let best = null, bestScore = -Infinity;
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
        // 鸣牌后手上多一张待打，比较"打掉一张后"的向听才公平
        const s = shantenAfterBestDiscard(after, jokers, needGroups - 1,
          { ...opt, hasChi: opt.hasChi || a.kind === 'chi' });
        // 轮次剥夺：碰/杠会跳过点炮者与自己之间的所有人，他们本该摸的牌没了。
        // 吃只能吃上家，本来下一个就轮到自己，所以不偷任何轮次。
        const stolen = a.kind === 'chi' ? 0 : ((player - view.pending.from + 4) % 4) - 1;
        const gain = cur - s + P.tempoBonus * stolen;
        if (P.callTenpaiOnly && s > 1) continue;
        if (gain < P.callNeedsGain) continue;
        // 明杠额外把自己的赔付倍率翻倍，要求更高
        const kongPenalty = a.kind === 'exposedKong' && s > P.voluntaryKongShanten ? 1.5 : 0;
        const score = gain * 10 - s * 3 - kongPenalty;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best || pass;
    }

    // ---- 自己回合：特殊杠 ----------------------------------------------
    // 皮子胡牌前必须杠掉，什么时候杠可以自选。默认"立刻杠"。
    // holdLastSkin：皮子多于一张时照杠，最后一张留到其余 13 张听牌才杠——
    // 补牌那一下就是一次杠上开花的机会；没听牌就一直不杠，也少翻一次自己的赔付倍率。
    // 代价是留着皮的时候不能胡（不能接炮，自摸也要先杠）。
    const skin = actions.find(a => a.kind === 'skinKong');
    if (skin) {
      if (!P.holdLastSkin) return skin;
      const skins = hand.filter(id => { const t = tileType(id); return t === 31 || t === view.indicatorType; }).length;
      if (skins >= 2) return skin;
      const live = Math.min(
        shantenStandard(counts, jokers, needGroups, true),
        shantenQidui(counts, jokers, needGroups),
        shantenPeng(counts, jokers, needGroups),
      );
      // counts 已排除皮子，是 13 张活牌；未折价向听 1 即听牌
      if (live <= 1) return skin;
      // 折中版：离听牌还远（向听 > holdSkinMaxXt）就照常马上杠，只在快听牌时才留皮等杠开，
      // 缩短"留着皮不能接炮"的窗口
      if (Number.isFinite(P.holdSkinMaxXt) && live - 1 > P.holdSkinMaxXt) return skin;
    }

    const jokerKongs = actions.filter(a => a.kind === 'jokerKong');
    if (jokerKongs.length >= P.jokerKongMin) return jokerKongs[0];

    const cur = bestShanten(counts, jokers, needGroups, opt);
    const voluntary = actions.filter(a => a.kind === 'concealedKong' || a.kind === 'addedKong');
    if (voluntary.length && cur <= P.voluntaryKongShanten) {
      // 暗杠不拆结构；补杠会把碰过的刻子升级，同样安全
      return voluntary[0];
    }

    // ---- 出牌 -----------------------------------------------------------
    const discards = actions.filter(a => a.kind === 'discard');
    if (!discards.length) return actions[actions.length - 1];
    // 消融开关：把出牌交回引擎的 discardHeuristic，用来把"鸣牌判断"和"出牌判断"
    // 的贡献拆开测。
    if (P.useEngineDiscard) return discardHeuristic(view, player, discards) || discards[0];
    return pickDiscard(view, player, discards, counts, jokers, needGroups, cur, P, opt);
  };
}

// 一步向听在打点上值多少分。安全度要能真正与之竞价，权重必须同量级——
// 这正是原 safeDiscardEvaluation 做不到的：它把 waits*10000 摆在最前面，
// 所谓"防守"只能在同向听的候选之间做文章，永远不会为了保命退一步。
const SHANTEN_WEIGHT = 200;

const EYE_TYPES = new Set([1, 4, 7, 10, 13, 16, 19, 22, 25]);
/** 留着这张牌的潜在价值，只用于同分裁决。字牌 0；幺九 1；二八 2；三到七 3；2/5/8 另加 2。 */
function keepValue(t) {
  if (t >= 27) return 0;
  const rank = (t % 9) + 1;
  const base = rank === 1 || rank === 9 ? 1 : rank === 2 || rank === 8 ? 2 : 3;
  return base + (EYE_TYPES.has(t) ? 2 : 0);
}

function pickDiscard(view, player, discards, counts, jokers, needGroups, cur, P, opt) {
  const vis = visibleCounts(view);
  const threat = maxThreat(view, player);
  const folding = P.defense > 0 && cur > P.foldShanten && threat >= P.foldThreat;
  // 听牌了就推，向听越远、威胁越大，安全的报价越高
  const defWeight = folding
    ? 4000
    : Math.min(90, P.defense * Math.max(0, threat - 1.0) * (cur <= 1 ? 4 : 14));

  const seen = new Set();
  const rough = [];
  for (const a of discards) {
    const t = tileType(a.tile);
    if (seen.has(t)) continue;
    seen.add(t);
    const isJoker = t === view.joker;
    let s;
    if (isJoker) s = bestShanten(counts, jokers - 1, needGroups, opt);
    else { counts[t] -= 1; s = bestShanten(counts, jokers, needGroups, opt); counts[t] += 1; }
    rough.push({ a, t, s, isJoker });
  }

  const minS = Math.min(...rough.map(r => r.s));
  let best = null, bestScore = -Infinity;
  for (const r of rough) {
    // 进张计算最贵，只给还有竞争力的候选算
    let uk = { kinds: 0, tiles: 0 };
    if (!folding && r.s <= minS + 1) {
      const uopt = { pongW: P.pongW, chiW: P.chiW };
      if (P.ukConsistent) uopt.shanten = (c, j, g) => bestShanten(c, j, g, opt);
      if (r.isJoker) uk = ukeire(counts, jokers - 1, needGroups, vis, uopt);
      else { counts[r.t] -= 1; uk = ukeire(counts, jokers, needGroups, vis, uopt); counts[r.t] += 1; }
    }
    const own = view.hands[player].filter(id => tileType(id) === r.t).length;
    const danger = dangerOf(r.t, vis, own);
    const jokerPenalty = r.isJoker ? 150 : 0;   // 赖子是全场最贵的牌，除非必要不打
    let shape = 0;
    if (P.shapeW) {
      const next = view.hands[player].slice();
      next.splice(next.findIndex(id => id === r.a.tile), 1);
      shape = shapeScore(view, player, next);
    }
    const score = -r.s * SHANTEN_WEIGHT + (uk.tiles * 6 + uk.kinds * 2) * P.ukWeight
      + shape * P.shapeW - danger * defWeight - jokerPenalty;
    // 同分裁决（tieKeep）：先打留着最没用的牌（字牌、幺九先走，2/5/8 最后），否则按手牌顺序
    const tie = P.tieKeep && best && Math.abs(score - bestScore) <= 1e-6 && keepValue(r.t) < keepValue(tileType(best.tile));
    if (score > bestScore + 1e-6 || tie || (!P.tieKeep && score > bestScore)) { bestScore = Math.max(score, bestScore); best = r.a; }
  }
  return best || discards[0];
}

export const REAL_STRATEGIES = {
  Apex: makePolicy("Apex"),
  Balanced: makePolicy("Balanced"),
  Efficient: makePolicy('Efficient'),
  Guarded: makePolicy('Guarded'),
  Closed: makePolicy('Closed'),
  Tempo: makePolicy('Tempo'),
};

export { bestShanten, shantenAfterBestDiscard, ownLiability };

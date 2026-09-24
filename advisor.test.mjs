import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, visibleState, tileType, NAMES } from './game.mjs';
import { advise } from './advisor.mjs';

const T = (name) => NAMES.indexOf(name);

/** 把 0 号的手牌、副露换成指定牌型；指示牌六条，所以赖子是七条，皮子是六条和红中。 */
function stateWith({ hand, melds = [] }) {
  const s = createGame({ seed: 4242 });
  const all = [...s.hands.flat(), ...s.wall, ...(s.deadWallTiles || [])];
  const used = new Set([s.indicator]);
  const pick = (t) => {
    const id = [t * 4, t * 4 + 1, t * 4 + 2, t * 4 + 3].find((x) => !used.has(x));
    assert.ok(id !== undefined, `no copy left for ${NAMES[t]}`);
    used.add(id);
    return id;
  };
  s.indicatorType = T('六条');
  s.indicator = pick(T('六条'));
  s.joker = T('七条');
  const meldIds = melds.map((m) => ({ ...m, tiles: m.types.map(pick), open: true }));
  const mine = hand.map(pick);
  const rest = all.filter((id) => !used.has(id) && tileType(id) !== T('六条') && tileType(id) !== 31);
  s.hands = [mine, rest.slice(0, 13), rest.slice(13, 26), rest.slice(26, 39)];
  s.wall = rest.slice(39);
  s.melds = [meldIds.map(({ types, ...m }) => m), [], [], []];
  s.specialKongs = [[], [], [], []];
  s.phase = 'play'; s.turn = 0; s.pending = null;
  s.canSelfKong = [true, false, false, false];
  s.lastDraw = mine[mine.length - 1]; s.lastDrawPlayer = 0;
  return s;
}

test('最后一张皮子、其余的牌已经听牌：建议先开皮杠，并列出杠开能胡的牌', () => {
  // 实战牌例：吃了一副筒子；手上 五六七万 三四条 七条(赖) 八条 七八九筒 + 红中(皮)
  const s = stateWith({
    hand: ['五万', '六万', '七万', '三条', '四条', '七条', '八条', '七筒', '八筒', '九筒', '中'].map(T),
    melds: [{ kind: 'chi', types: [T('一筒'), T('二筒'), T('三筒')] }],
  });
  const adv = advise(visibleState(s, 0), 0);
  assert.equal(adv.mode, 'kong', `应当建议先杠，实际是 ${adv.mode}：${adv.headline}`);
  assert.equal(adv.best.kind, 'skinKong');
  assert.equal(tileType(adv.best.tile), 31);
  const kai = adv.waits.filter((w) => w.gangKai).map((w) => NAMES[w.t]);
  for (const t of ['二条', '五条', '八条']) assert.ok(kai.includes(t), `杠开应当能胡 ${t}，实际 ${kai.join('、')}`);
  assert.match(adv.kongNote, /赖杠先别开/, '赖子正当万能牌用，开赖杠会拆掉听牌');
});

test('皮子在手但其余的牌没听：照常给出牌建议，杠只附一句', () => {
  const s = stateWith({
    hand: ['一万', '五万', '九万', '三条', '四条', '七条', '八条', '二筒', '八筒', '东', '中'].map(T),
    melds: [{ kind: 'chi', types: [T('一筒'), T('二筒'), T('三筒')] }],
  });
  const adv = advise(visibleState(s, 0), 0);
  assert.equal(adv.mode, 'discard');
  assert.match(adv.kongNote, /皮杠/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, visibleState, tileType, NAMES } from '../src/game.mjs';
import { advise, shantenLabel } from '../src/advisor.mjs';

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

test('建议与困难档同一口径：对子多时走七对，显示真实向听并注明路线', () => {
  // 五对 + 四张散牌，屁胡路线还很远；打一张散牌后七对差两对 = 1 向听
  const s = stateWith({
    hand: ['一万', '一万', '四万', '四万', '二条', '二条', '五筒', '五筒', '东', '东', '九万', '八条', '一筒', '南'].map(T),
  });
  const adv = advise(visibleState(s, 0), 0);
  assert.equal(adv.mode, 'discard');
  const top = adv.rows[0];
  assert.equal(top.route, '七对');
  assert.equal(shantenLabel(top), '七对 · 1 向听', '显示的是七对的真实步数，不是带折价的排序分');
  assert.ok(['九万', '八条', '一筒', '南'].includes(NAMES[top.type]), `应当打散牌，实际打 ${NAMES[top.type]}`);
});

test('两张赖子：少一张万能牌不变慢就建议开赖杠，会变慢就留着（灵活赖杠，与困难同一判据）', () => {
  // 四副顺子已成（两门，做不成清一色），两张赖子（七条）：屁胡只能一张当万能牌，第二张多余，杠了白拿 ×4
  const kong = stateWith({ hand: ['一万', '二万', '三万', '七万', '八万', '九万', '四筒', '五筒', '六筒', '二筒', '三筒', '四筒', '七条', '七条'].map(T) });
  const a = advise(visibleState(kong, 0), 0);
  assert.equal(a.mode, 'kong', `应当建议开赖杠，实际是 ${a.mode}：${a.headline}`);
  assert.equal(a.best.kind, 'jokerKong');
  // 七对：四个对子 + 两张赖子，两张都要当万能牌补对子，杠一张就慢一步
  const keep = stateWith({ hand: ['一万', '一万', '三万', '三万', '五筒', '五筒', '东', '东', '西', '北', '发', '九筒', '七条', '七条'].map(T) });
  const b = advise(visibleState(keep, 0), 0);
  assert.equal(b.mode, 'discard');
  assert.notEqual(tileType(b.best.tile), T('七条'));
  assert.equal(b.rows[0].route, '七对');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateHand, settle } from './scoring.mjs';

const makePlayers = (changes = {}) => [0, 1, 2, 3].map(i => ({
  open: false, kongCount: 0, jokerKongCount: 0, ...(changes[i] || {}),
}));

// 胡家（0 号）已开口。门清屁胡只能自摸，所以屁胡点炮的用例都让胡家先开口。
const openWinner = (changes = {}) => makePlayers({ 0: { open: true }, ...changes });

const base = {
  melds: [], specialKongs: [], indicator: 8, joker: 33, cap: 50,
  selfDraw: false, from: 1, winner: 0, players: makePlayers(),
  gangKai: false, haidi: false, robKong: false,
};

const pihu = [0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 4, 4];
const pihuLowEye = [0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 0, 0];
const pihuOneJoker = [0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 4, 33];
const pihuTwoJokers = [0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 33, 33];
const evalHand = (hand, extra = {}) => evaluateHand({ ...base, ...extra, hand });

test('settle: each payer independently needs four points', () => {
  assert.deepEqual(settle({ W: 2, winner: 0, from: 1, players: makePlayers({ 1: { open: true } }), cap: 50 }),
    { payments: [0, 4, 0, 0], total: 4 });
  assert.deepEqual(settle({ W: 2, winner: 0, selfDraw: true, players: makePlayers(), cap: 50 }),
    { payments: [0, 0, 0, 0], total: 0 });
});

test('settle: seven pairs and dahu point炮 charge all three payers', () => {
  assert.deepEqual(settle({ W: 4, sevenPairs: true, winner: 0, from: 1, players: makePlayers(), cap: 50 }),
    { payments: [0, 4, 4, 4], total: 12 });
  assert.deepEqual(settle({ W: 8, big: true, winner: 0, from: 1, players: makePlayers(), cap: 50 }),
    { payments: [0, 8, 8, 8], total: 24 });
});

test('settle: cap and half-cap top-out are per payer', () => {
  assert.deepEqual(settle({ W: 64, winner: 0, selfDraw: true, players: makePlayers(), cap: 50 }),
    { payments: [0, 75, 75, 75], total: 225 });
  assert.deepEqual(settle({ W: 64, winner: 0, selfDraw: true, players: makePlayers({ 1: { open: true } }), cap: 50 }),
    { payments: [0, 50, 75, 75], total: 200 });
  assert.deepEqual(settle({ W: 32, winner: 0, selfDraw: true,
    players: makePlayers({ 1: { open: true }, 2: { kongCount: 1 } }), cap: 50 }),
    { payments: [0, 50, 50, 32], total: 132 });
});

test('settle: gold top-out needs a three-payer win; 屁胡点炮 never pays the half-cap', () => {
  // 屁胡点炮：只有点炮者付，胡家倍数到了封顶也只付封顶，没有顶外半顶
  assert.deepEqual(settle({ W: 64, winner: 0, from: 1, players: makePlayers(), cap: 50 }),
    { payments: [0, 50, 0, 0], total: 50 });
  // 大胡点炮：三家付，达到封顶即金顶，未开口者另付半顶
  assert.deepEqual(settle({ W: 64, big: true, winner: 0, from: 1, players: makePlayers({ 2: { open: true } }), cap: 50 }),
    { payments: [0, 75, 50, 75], total: 200 });
  // 七对点炮也是三家付
  assert.deepEqual(settle({ W: 64, sevenPairs: true, winner: 0, from: 1, players: makePlayers(), cap: 50 }),
    { payments: [0, 75, 75, 75], total: 225 });
});

test('settle: payer open, ordinary kong and joker kong multiply independently', () => {
  assert.deepEqual(settle({ W: 2, winner: 0, from: 1,
    players: makePlayers({ 1: { open: true, kongCount: 1, jokerKongCount: 1 } }), cap: 50 }),
  { payments: [0, 32, 0, 0], total: 32 });
});

test('plain hard屁胡 requires a 2/5/8 eye and has hard胡 x2', () => {
  assert.equal(evalHand(pihu), null, 'W=2 against a closed x1 payer does not reach four');
  const r = evalHand(pihu, { players: openWinner({ 1: { open: true } }) });
  assert.ok(r);
  assert.deepEqual(r.labels, ['屁胡']);
  assert.equal(r.W, 2);
  assert.equal(r.hard, true);
  assert.deepEqual(r.payments, [0, 4, 0, 0]);
  assert.equal(evalHand(pihuLowEye, { players: openWinner({ 1: { open: true } }) }), null);
});

test('one physical joker is a soft屁胡; two are prohibited only for plain屁胡', () => {
  const one = evalHand(pihuOneJoker, {
    players: openWinner({ 1: { open: true, kongCount: 1 } }),
  });
  assert.ok(one);
  assert.deepEqual(one.labels, ['屁胡']);
  assert.equal(one.W, 1);
  assert.equal(one.hard, false);
  assert.deepEqual(one.payments, [0, 4, 0, 0]);
  assert.equal(evalHand(pihuTwoJokers, {
    players: openWinner({ 1: { open: true, kongCount: 1, jokerKongCount: 1 } }),
  }), null);
});

test('two-joker屁胡 stays prohibited even when the winner itself reaches cap', () => {
  const fourSkins = [
    { kind: 'skin', tile: 8 }, { kind: 'skin', tile: 31 },
    { kind: 'skin', tile: 31 }, { kind: 'skin', tile: 31 },
  ];
  // 四个皮杠，胡家自身 ×16 已超过封顶 10，两赖屁胡仍然不能胡（点炮、自摸都不行）
  assert.equal(evalHand(pihuTwoJokers, { cap: 10, specialKongs: fourSkins, players: openWinner() }), null);
  assert.equal(evalHand(pihuTwoJokers, { cap: 10, specialKongs: fourSkins, selfDraw: true, from: null, players: openWinner() }), null);
  // 同样两张赖子，大胡照样能胡：清一色、杠上开花
  assert.ok(evalHand([0, 1, 2, 1, 2, 3, 3, 4, 5, 6, 6, 7, 33, 33], { players: openWinner({ 1: { open: true } }) }));
  assert.ok(evalHand(pihuTwoJokers, { selfDraw: true, from: null, gangKai: true, specialKongs: [{ kind: 'skin', tile: 31 }] }));
});

test('hard restoration: joker used as its own tile is hard胡', () => {
  const r = evalHand([0, 1, 2, 3, 4, 5, 9, 10, 11, 18, 19, 20, 22, 22], {
    indicator: 8, joker: 0,
    players: openWinner({ 1: { open: true } }),
  });
  assert.ok(r);
  assert.equal(r.W, 2);
  assert.equal(r.hard, true);
});

test('ordinary soft七对 is x4 and point炮 pays all three', () => {
  const r = evalHand([0, 0, 1, 1, 9, 9, 10, 10, 18, 18, 19, 19, 27, 33]);
  assert.ok(r);
  assert.deepEqual(r.labels, ['七对']);
  assert.equal(r.W, 4);
  assert.equal(r.hard, false);
  assert.deepEqual(r.payments, [0, 4, 4, 4]);
});

test('hard ordinary七对 receives the extra hard胡 factor', () => {
  const r = evalHand([0, 0, 1, 1, 9, 9, 10, 10, 18, 18, 19, 19, 27, 27]);
  assert.ok(r);
  assert.deepEqual(r.labels, ['七对']);
  assert.equal(r.W, 8);
  assert.equal(r.hard, true);
});

test('natural four of a kind is豪华七对 and starts at x8', () => {
  const r = evalHand([0, 0, 0, 0, 1, 1, 9, 9, 10, 10, 18, 18, 19, 19]);
  assert.ok(r);
  assert.deepEqual(r.labels, ['豪华七对']);
  assert.equal(r.W, 16);
  assert.equal(r.hard, true);
});

test('each single skin kong is an independent x2, including two red centers', () => {
  const r = evalHand(pihuOneJoker, {
    specialKongs: [{ kind: 'skin', tile: 31 }, { kind: 'skin', tile: 31 }],
    players: openWinner({ 1: { open: true } }),
  });
  assert.ok(r);
  assert.equal(r.W, 4);
  assert.equal(r.hard, false);
  assert.equal(r.factors.filter(x => x.name === '杠').length, 2);
});

test('a joker kong is x4 and removes that joker from the hard胡 check', () => {
  const r = evalHand(pihu, {
    specialKongs: [{ kind: 'joker', tile: 33 }],
    players: openWinner(),
  });
  assert.ok(r);
  assert.equal(r.W, 8);
  assert.equal(r.hard, true);
  assert.equal(r.factors.filter(x => x.name === '赖杠').length, 1);
});

test('seven pairs may coexist with skin and joker kongs', () => {
  const r = evalHand([0, 0, 0, 0, 1, 1, 9, 9, 10, 10, 18, 18, 19, 19], {
    specialKongs: [
      { kind: 'skin', tile: 8 }, { kind: 'skin', tile: 31 }, { kind: 'joker', tile: 33 },
    ],
  });
  assert.ok(r);
  assert.deepEqual(r.labels, ['豪华七对']);
  assert.equal(r.W, 256);
});

test('clean one and碰碰胡 multiply, with no confusion between big and cap', () => {
  const r = evalHand([0, 0, 0, 1, 1, 1, 2, 2, 2, 4, 4, 4, 7, 7]);
  assert.ok(r);
  assert.deepEqual(r.labels, ['碰碰胡', '清一色']);
  assert.equal(r.W, 128);
  assert.equal(r.big, true);
  assert.deepEqual(r.payments, [0, 75, 75, 75]);
});

test('将一色 keeps its own unconstrained eye and may use jokers across the same mode', () => {
  const r = evalHand([1, 1, 1, 1, 4, 4, 4, 4, 7, 7, 7, 33, 33, 33]);
  assert.ok(r);
  assert.ok(r.labels.includes('将一色'));
  assert.ok(r.labels.includes('碰碰胡'));
  assert.ok(r.labels.includes('清一色'));
  assert.equal(r.W, 512);
  assert.equal(r.hard, false);
});

test('风一色 can be a hard all-pong hand', () => {
  const r = evalHand([27, 27, 27, 28, 28, 28, 29, 29, 29, 30, 30, 30, 33, 33]);
  assert.ok(r);
  assert.deepEqual(r.labels, ['碰碰胡', '风一色']);
  assert.equal(r.W, 128);
  assert.equal(r.hard, true);
});

test('全求人 is a point-shot dahu and releases the 2/5/8 eye restriction', () => {
  const r = evalHand([0, 0], {
    melds: [
      { kind: 'chi', tiles: [0, 1, 2], open: true },
      { kind: 'chi', tiles: [3, 4, 5], open: true },
      { kind: 'pong', tiles: [9, 9, 9], open: true },
      { kind: 'pong', tiles: [18, 18, 18], open: true },
    ],
  });
  assert.ok(r);
  assert.deepEqual(r.labels, ['全求人']);
  assert.equal(r.W, 16);
  assert.deepEqual(r.payments, [0, 16, 16, 16]);
});

test('海底捞 is an independent dahu factor', () => {
  const hai = evalHand([0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 1, 1], {
    selfDraw: true, from: null, haidi: true,
  });
  assert.ok(hai);
  assert.deepEqual(hai.labels, ['海底捞']);
  assert.equal(hai.W, 16);
});

test('ordinary concealed kong is a winner x2 factor and does not open the winner', () => {
  const r = evalHand([0, 1, 2, 0, 1, 2, 18, 19, 20, 4, 4], {
    melds: [{ kind: 'kong', tiles: [9, 9, 9, 9], open: false }],
    selfDraw: true, from: null,
  });
  assert.ok(r);
  assert.deepEqual(r.labels, ['屁胡']);
  assert.equal(r.W, 4);
  assert.equal(r.factors.filter(x => x.name === '杠').length, 1);
});

test('杠开 is counted only on a self-draw', () => {
  const r = evalHand([0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 1, 1], {
    selfDraw: true, from: null, gangKai: true,
  });
  assert.ok(r);
  assert.ok(r.labels.includes('杠上开花'));
  // 杠上开花自身 ×4：屁胡 1 × 硬胡 2 × 杠开 4 = 8
  assert.equal(r.W, 8);
  assert.deepEqual(r.payments, [0, 8, 8, 8]);
  const point = evalHand(pihu, { gangKai: true, players: openWinner({ 1: { open: true } }) });
  assert.ok(point);
  assert.equal(point.W, 2);
});

test('杠上开花算大胡：自身 ×4，乘上必然存在的那个杠 = ×8（赖杠则 ×16）', () => {
  // 杠上开花必定伴随一个杠，所以"没有杠记录"的杠开是不存在的局面，不作对照。
  const hand = [0, 1, 2, 0, 1, 2, 9, 10, 11, 18, 19, 20, 1, 1];
  const opts = { selfDraw: true, from: null, gangKai: true };
  const bySkin = evalHand(hand, { ...opts, specialKongs: [{ kind: 'skin', tile: 8 }] });
  // 赖杠的牌必须等于赖子；这套夹具里赖子是 33（白）
  const byJoker = evalHand(hand, { ...opts, specialKongs: [{ kind: 'joker', tile: 33 }] });
  assert.ok(bySkin, 'skin-kong gangkai should score');
  assert.ok(byJoker, 'joker-kong gangkai should score');

  const mult = (r, name) => r.factors.filter(f => f.name === name)
    .reduce((a, f) => a * f.multiplier, 1);
  // 杠开自身 ×4，触发它的杠照常计番
  assert.equal(mult(bySkin, '杠上开花'), 4);
  assert.equal(mult(bySkin, '杠上开花') * mult(bySkin, '杠'), 8);
  assert.equal(mult(byJoker, '杠上开花') * mult(byJoker, '赖杠'), 16);
  assert.equal(byJoker.W / bySkin.W, 2);

  // 算大胡 → 三家都要付
  assert.ok(bySkin.payments.every((v, i) => (i === 0 ? v === 0 : v > 0)));

  // 但杠上开花不免除 2/5/8 将：三条做将应当不成立
  const nonEye = evalHand([0, 1, 2, 0, 1, 2, 9, 10, 18, 19, 20, 11, 11, 11], {
    ...opts, specialKongs: [{ kind: 'skin', tile: 8 }],
  });
  assert.equal(nonEye, null, '杠上开花按大胡计分，但将牌仍须 2/5/8');
});

test('门前清屁胡不能捉铳，只能自摸；暗杠、皮杠、赖杠不算开口；七对和大胡不受限', () => {
  const payerOpen = { 1: { open: true, kongCount: 1 } };
  // 门清：点炮不能胡，哪怕点炮者打点够 4
  assert.equal(evalHand(pihu, { players: makePlayers(payerOpen) }), null);
  // 抢杠也是别人的牌，同样不行
  assert.equal(evalHand(pihu, { robKong: true, players: makePlayers(payerOpen) }), null);
  // 手里有暗杠、皮杠、赖杠仍是门清
  assert.equal(evalHand([0, 1, 2, 0, 1, 2, 18, 19, 20, 4, 4], {
    melds: [{ kind: 'kong', tiles: [9, 9, 9, 9], open: false }],
    specialKongs: [{ kind: 'skin', tile: 31 }, { kind: 'joker', tile: 33 }],
    players: makePlayers(payerOpen),
  }), null);
  // 同一手牌自摸可以胡
  const tsumo = evalHand(pihu, { selfDraw: true, from: null, players: makePlayers({ 1: { open: true }, 2: { open: true }, 3: { open: true } }) });
  assert.ok(tsumo);
  assert.deepEqual(tsumo.payments, [0, 4, 4, 4]);
  // 胡家开口后可以捉铳
  assert.ok(evalHand(pihu, { players: openWinner(payerOpen) }));
  // 七对、大胡门清也能捉铳
  assert.ok(evalHand([0, 0, 1, 1, 9, 9, 10, 10, 18, 18, 19, 19, 27, 27]));
  assert.ok(evalHand([0, 0, 0, 1, 1, 1, 2, 2, 2, 4, 4, 4, 7, 7]));
});

test('invalid skin in hand and invalid joker meld are rejected', () => {
  assert.equal(evalHand([...pihu.slice(0, 13), 8]), null);
  assert.equal(evalHand(pihu, { melds: [{ kind: 'pong', tiles: [33, 33, 33], open: true }] }), null);
  assert.equal(evalHand(pihu, {
    specialKongs: [
      { kind: 'skin', tile: 8 }, { kind: 'skin', tile: 8 },
      { kind: 'skin', tile: 8 }, { kind: 'skin', tile: 8 },
    ],
  }), null, 'the flipped indicator already consumes one copy');
});

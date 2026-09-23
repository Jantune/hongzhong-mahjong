import test from 'node:test';
import assert from 'node:assert/strict';
import { ukeire, shantenStandard, shantenQidui, shantenPeng } from './handeval.mjs';
import { NAMES } from './game.mjs';

// 与建议面板、稳健/精算策略相同的折价向听
const penalized = (c, j, g) => Math.min(
  shantenStandard(c, j, g, true),
  shantenQidui(c, j, g) + 1.5,
  shantenPeng(c, j, g) + 1.0,
);

function countsOf(names) {
  const c = new Array(34).fill(0);
  for (const n of names) c[NAMES.indexOf(n)] += 1;
  return c;
}

// 实战牌例（五筒是皮，不计入）：二万 六万 二条 三条 三条 五条 九条 三筒 南 南 白 白 一筒
const HAND = ['二万', '六万', '二条', '三条', '三条', '五条', '九条', '三筒', '南', '南', '白', '白', '一筒'];

function kindsAfter(discard, opt) {
  const c = countsOf(HAND);
  c[NAMES.indexOf(discard)] -= 1;
  return ukeire(c, 0, 4, null, opt).kinds;
}

test('ukeire with the penalized shanten prefers the isolated terminal over breaking a pair', () => {
  const opt = { shanten: penalized };
  assert.equal(kindsAfter('九条', opt), 12);
  assert.equal(kindsAfter('三条', opt), 8);
});

test('ukeire without the option keeps the old unpenalized measure', () => {
  // 旧口径：打九条后未折价七对领先，只数凑对子的牌
  assert.equal(kindsAfter('九条', {}), 6);
  assert.equal(kindsAfter('三条', {}), 13);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { situationHash } from './strategies_real.mjs';

test('situationHash is a uniform number in [0, 1), so blunder rates mean what they say', () => {
  const xs = [];
  let r = 12345;
  const next = () => { r = (r * 1103515245 + 12345) % 2147483648; return r; };
  for (let k = 0; k < 4000; k += 1) {
    // 取 LCG 的高位：低位周期很短，直接取模会让手牌高度重复
    const hand = Array.from({ length: 13 }, () => Math.floor(next() / 2147483648 * 136));
    const view = { hands: [hand, [], [], []], discards: [Array(k % 20).fill(0), [], [], []], round: k % 5 };
    xs.push(situationHash(view, k % 4));
  }
  assert.ok(xs.every((x) => x >= 0 && x < 1), 'every value must be in [0, 1)');
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.03, `mean ${mean} should be close to 0.5`);
  const below = xs.filter((x) => x < 0.3).length / xs.length;
  assert.ok(Math.abs(below - 0.3) < 0.03, `share below 0.3 is ${below}`);
});

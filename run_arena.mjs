// 评测台命令行入口。支持分片并行：--shard i --of n，各自写出 JSON 后合并。
//
//   node run_arena.mjs --lineup Guarded,Tempo,Greedy,Closed --mode duplicate --blocks 240
//   node run_arena.mjs ... --shard 3 --of 12 --out part3.json

import { writeFileSync, readFileSync } from 'node:fs';
import { runDuplicate, runBust, mergeResults, report } from './arena.mjs';
import { REAL_STRATEGIES, PROFILES, makePolicy } from './strategies_real.mjs';
import { STRATEGIES as LEGACY } from './simulate_tournament.mjs';
import { aiChoose } from './game.mjs';

// Baseline = 引擎自带的 aiChoose，「对 3 家引擎基线」的对照组
export const ALL_STRATEGIES = { ...LEGACY, ...REAL_STRATEGIES, Baseline: aiChoose };

/** --profiles '{"G_d0":{"base":"Guarded","defense":0}}' 临时注册调参变体。 */
function registerProfiles(json) {
  const spec = JSON.parse(json);
  for (const [name, patch] of Object.entries(spec)) {
    const base = PROFILES[patch.base || 'Guarded'];
    if (!base) throw Error(`unknown base profile ${patch.base}`);
    const { base: _drop, ...over } = patch;
    ALL_STRATEGIES[name] = makePolicy({ ...base, ...over });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv);
  if (a.merge) {
    const parts = a.merge.split(',').map(f => JSON.parse(readFileSync(f, 'utf8')));
    const merged = mergeResults(parts);
    console.log(report(merged, a.title || '合并结果'));
    if (a.out) writeFileSync(a.out, JSON.stringify(merged));
    return;
  }

  if (a.profiles) registerProfiles(a.profiles);
  const lineup = (a.lineup || 'Guarded,Tempo,Greedy,Closed').split(',');
  for (const n of lineup) if (!ALL_STRATEGIES[n]) throw Error(`unknown strategy ${n}`);
  const cfg = {
    lineup,
    strategies: ALL_STRATEGIES,
    blocks: Number(a.blocks || 120),
    seedStart: Number(a.seedStart || 10000),
    cap: Number(a.cap || 50),   // 与游戏默认封顶一致
    shard: Number(a.shard || 0),
    shardCount: Number(a.of || 1),
  };
  const result = (a.mode === 'bust') ? runBust(cfg) : runDuplicate(cfg);
  if (a.out) writeFileSync(a.out, JSON.stringify(result));
  else console.log(report(result, a.title || lineup.join(' vs ')));
}

main();

// 大模型上桌的最小实验：一家模型 + 三家引擎，测延迟、无效回答率和得分。
//
//   node run_agent_trial.mjs --seeds 2              # 冒烟：2 副牌 × 4 个座位 = 8 小局
//   node run_agent_trial.mjs --seeds 8 --opp Guarded --concurrency 4
//
// 配置读环境变量（与 server.mjs 同名），进程里没有时再去读 Windows 用户级环境变量，
// 所以刚用 SetEnvironmentVariable 设完、不重开终端也能用：
//   HZ_BASE_CUSTOM   接口地址（OpenAI 兼容）
//   HZ_KEY_CUSTOM    密钥
//   HZ_MODEL_CUSTOM  模型名（可选，也可用 --model）
//
// 对照组：同一副牌、同一个座位、同样的三家对手，把模型换成「稳健」再打一遍。
// 引擎决策只由局面决定，发牌只由种子决定，所以两边是严格配对的比较。
// 对照组在本地算，不花钱。

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, applyAction, aiChoose } from './game.mjs';
import { REAL_STRATEGIES } from './strategies_real.mjs';
import { makeAgentPolicy, rulesFromHtml } from './agent_seat.mjs';
import { describeTarget } from './llm.mjs';

const root = dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[k] = v;
  }
  return out;
}

/** 进程环境 → Windows 用户级环境变量（注册表 HKCU\Environment）。 */
function env(name) {
  if (process.env[name]) return process.env[name];
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

const OPPONENTS = {
  Baseline: aiChoose,
  Guarded: REAL_STRATEGIES.Guarded,
  Efficient: REAL_STRATEGIES.Efficient,
};

async function playRound(state, policies, maxSteps = 800) {
  let steps = 0;
  while (state.phase !== 'done' && steps < maxSteps) {
    const player = state.pending
      ? Number(Object.keys(state.pending.responses).find((k) => state.pending.responses[k] === undefined))
      : state.turn;
    if (!Number.isInteger(player)) return { state, stalled: true };
    const action = await policies[player](state, player);
    state = applyAction(state, action);
    steps += 1;
  }
  return { state, stalled: state.phase !== 'done' };
}

function summarize(state, seat) {
  const r = state.result;
  return {
    points: state.scores[seat],
    win: r?.type === 'win' && r.winner === seat,
    selfDraw: r?.type === 'win' && r.winner === seat && r.from === null,
    dealIn: r?.type === 'win' && r.from === seat && r.winner !== seat,
    draw: r?.type === 'draw',
  };
}

const pct = (xs, q) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

async function main() {
  const a = args(process.argv);
  const seeds = Number(a.seeds || 2);
  const seedStart = Number(a.seedStart || 20000);
  const cap = Number(a.cap || 32);
  const concurrency = Number(a.concurrency || 4);
  const opp = a.opp || 'Baseline';
  if (!OPPONENTS[opp]) throw Error(`--opp 只能是 ${Object.keys(OPPONENTS).join(' / ')}`);

  const llm = {
    provider: 'custom',
    baseUrl: env('HZ_BASE_CUSTOM'),
    key: env('HZ_KEY_CUSTOM'),
    model: a.model || env('HZ_MODEL_CUSTOM') || 'TPK/DeepSeek-V4-Flash',
    timeoutMs: Number(a.timeout || 30_000),
  };
  if (!llm.baseUrl) throw Error('没有读到 HZ_BASE_CUSTOM（接口地址）。');
  if (!llm.key) throw Error('没有读到 HZ_KEY_CUSTOM（密钥）。');
  // 密钥只报有没有，不打印内容
  console.log(`模型 ${llm.model} · ${describeTarget(llm)} · 密钥已设置 · 对手 3×${opp} · 封顶 ${cap}`);

  const rules = rulesFromHtml(readFileSync(join(root, 'index.html'), 'utf8'));
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logFile = join(outDir, `agent-${stamp}.jsonl`);

  const decisions = [];
  const jobs = [];
  for (let b = 0; b < seeds; b += 1) {
    for (let seat = 0; seat < 4; seat += 1) jobs.push({ seed: seedStart + b * 1009, seat });
  }

  const rows = [];
  let next = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const onDecision = (d) => {
        const rec = { seed: job.seed, ...d };
        decisions.push(rec);
        appendFileSync(logFile, `${JSON.stringify(rec)}\n`);
      };
      const agent = makeAgentPolicy({ llm, rules, onDecision });
      const mk = (mine) => [0, 1, 2, 3].map((p) => (p === job.seat ? mine : OPPONENTS[opp]));
      const fresh = () => createGame({ cap, seed: job.seed, dealer: 0, scores: [0, 0, 0, 0], round: 1 });

      const roundStart = Date.now();
      const llmRun = await playRound(fresh(), mk(agent));
      const guardRun = await playRound(fresh(), mk(REAL_STRATEGIES.Guarded));
      const baseRun = await playRound(fresh(), mk(aiChoose));
      const row = {
        ...job,
        secs: Math.round((Date.now() - roundStart) / 1000),
        llm: summarize(llmRun.state, job.seat),
        guarded: summarize(guardRun.state, job.seat),
        baseline: summarize(baseRun.state, job.seat),
        stalled: llmRun.stalled,
      };
      rows.push(row);
      console.log(`种子 ${job.seed} 座位 ${job.seat}：模型 ${row.llm.points > 0 ? '+' : ''}${row.llm.points}，稳健 ${row.guarded.points > 0 ? '+' : ''}${row.guarded.points}，基线 ${row.baseline.points > 0 ? '+' : ''}${row.baseline.points} · ${row.secs}s`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const calls = decisions.flatMap((d) => d.attempts);
  const lat = calls.filter((c) => !c.error).map((c) => c.ms);
  const sum = (k, f) => rows.reduce((s, r) => s + f(r[k]), 0);
  const report = {
    model: llm.model,
    opponents: opp,
    rounds: rows.length,
    wallSecs: Math.round((Date.now() - t0) / 1000),
    decisions: decisions.length,
    apiCalls: calls.length,
    errors: calls.filter((c) => c.error).length,
    unparsed: calls.filter((c) => !c.error && !c.ok).length,
    fallbacks: decisions.filter((d) => d.fallback).length,
    latencyMs: { p50: pct(lat, 0.5), p90: pct(lat, 0.9), max: Math.max(...lat) },
    perRound: Object.fromEntries(['llm', 'guarded', 'baseline'].map((k) => [k, {
      points: +(sum(k, (x) => x.points) / rows.length).toFixed(2),
      winRate: +(sum(k, (x) => +x.win) / rows.length).toFixed(3),
      dealInRate: +(sum(k, (x) => +x.dealIn) / rows.length).toFixed(3),
    }])),
    sampleErrors: calls.filter((c) => c.error).slice(0, 3).map((c) => c.error),
    log: logFile,
  };
  writeFileSync(join(outDir, `agent-${stamp}.summary.json`), JSON.stringify({ report, rows }, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e.message); process.exit(1); });

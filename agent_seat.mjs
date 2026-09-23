// 让大模型坐上一个座位打牌。
//
// 边界是刻意的：
//   - 规则仍由引擎管。模型只做选择题：从 legalActions 列出的合法动作里挑一个编号，
//     所以它不可能打出违规的牌。
//   - 模型只看 visibleState(state, seat)：自己的手牌 + 全场公开信息，看不到别人的暗牌。
//   - 策略完全交给模型：不给向听、进张、危险度这些引擎数字，也不给工具。
//     这正是要测的东西——纯模型能打成什么样。
//   - 模型超时、答非所问或选了不存在的编号：重试一次，还不行就这一步交给引擎
//     基线代打，并计数。实验报告里这个比例必须看。
//
// 每次决策都是无状态的：局面描述里已经带了全场牌河与副露（麻将的公开历史就是这些），
// 不需要多轮对话。这样每次调用的输入长度稳定，也不会越打越慢。

import { visibleState, legalActions, aiChoose, NAMES } from './game.mjs';
import { ask } from './llm.mjs';

const SEAT_NAMES = ['南家', '东家', '北家', '西家'];
const typeOf = (id) => Math.floor(Number(id) / 4);

/** 从 index.html 的玩法说明里取规则原文，和玩家看到的是同一份。 */
export function rulesFromHtml(html) {
  const start = html.indexOf('<dialog id="drawer"');
  const end = html.indexOf('</dialog>', start);
  if (start < 0 || end < 0) return '';
  return html.slice(start, end)
    .replace(/<button[^>]*>.*?<\/button>/gs, '')
    .replace(/<p class="drawer-foot">.*?<\/p>/gs, '')
    .replace(/<h[23][^>]*>(.*?)<\/h[23]>/gs, '\n【$1】\n')
    .replace(/<\/p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function tag(view, id) {
  const t = typeOf(id);
  if (t === 31 || t === view.indicatorType) return `${NAMES[t]}(皮)`;
  if (t === view.joker) return `${NAMES[t]}(赖)`;
  return NAMES[t];
}

const tiles = (view, ids) => (ids?.length ? ids.map((id) => tag(view, id)).join(' ') : '无');

function sortedHand(view, seat) {
  return [...(view.hands[seat] || [])].sort((a, b) => typeOf(a) - typeOf(b) || a - b);
}

function meldsText(view, p) {
  const out = [];
  for (const m of view.melds[p] || []) {
    const kind = { chi: '吃', pong: '碰', kong: '杠' }[m.kind] || m.kind;
    out.push(`${kind}[${(m.tiles || []).map((id) => NAMES[typeOf(id)]).join('')}]${m.open ? '' : '(暗)'}`);
  }
  for (const k of view.specialKongs[p] || []) {
    out.push(`${k.kind === 'joker' ? '赖杠' : '皮杠'}[${NAMES[typeOf(k.tile)]}]`);
  }
  return out.length ? out.join(' ') : '无';
}

/** 以 seat 为第一人称的局面描述。行牌顺序 p → p+1，所以 p+3 是上家（只能吃上家的牌）。 */
export function describeSeat(view, seat) {
  const rel = (p) => ['你', '下家', '对家', '上家'][(p - seat + 4) % 4];
  const who = (p) => `${rel(p)}（${SEAT_NAMES[p]}）`;
  const lines = [];
  lines.push(`你是${SEAT_NAMES[seat]}${view.dealer === seat ? '，本局庄家' : ''}。`);
  lines.push(`指示牌 ${NAMES[view.indicatorType]}；皮子：${NAMES[view.indicatorType]}、红中；赖子：${NAMES[view.joker]}。牌墙还剩 ${view.wall} 张可摸。`);
  lines.push('');
  lines.push(`你的手牌（${view.hands[seat].length} 张）：${tiles(view, sortedHand(view, seat))}`);
  if (view.lastDraw != null && !view.pending && view.turn === seat) lines.push(`刚摸到：${tag(view, view.lastDraw)}`);
  lines.push(`你的副露：${meldsText(view, seat)}`);
  lines.push(`你打出过：${tiles(view, view.discards[seat])}`);
  lines.push('');
  for (const d of [1, 2, 3]) {
    const p = (seat + d) % 4;
    lines.push(`${who(p)}：手牌 ${view.hands[p].length} 张；副露 ${meldsText(view, p)}；打出过 ${tiles(view, view.discards[p])}`);
  }
  lines.push('');
  lines.push(`累计分：${[0, 1, 2, 3].map((p) => `${rel(p)} ${view.scores[p]}`).join('，')}`);
  if (view.pending) {
    lines.push('');
    lines.push(`${who(view.pending.from)}刚打出 ${tag(view, view.pending.tile)}，你要决定是否响应。`);
  }
  return lines.join('\n');
}

function actionLabel(view, a) {
  const t = a.tile === undefined ? '' : tag(view, a.tile);
  switch (a.kind) {
    case 'discard': return `打出 ${t}`;
    case 'pass': return '过（不吃不碰不杠不胡）';
    case 'win': return view.pending ? `胡 ${t}（点炮）` : '胡（自摸）';
    case 'pong': return `碰 ${t}`;
    case 'chi': return `吃 ${t}（用 ${(a.tiles || []).map((id) => NAMES[typeOf(id)]).join('、')}）`;
    case 'kong': return `明杠 ${t}`;
    case 'concealedKong': return `暗杠 ${t}`;
    case 'addedKong': return `蓄杠 ${t}`;
    case 'skinKong': return `皮杠 ${t}`;
    case 'jokerKong': return `赖杠 ${t}`;
    default: return a.kind;
  }
}

/** 合法动作去重：同一种牌的几张实体牌打出去没有区别，只留一个选项。 */
export function choiceList(view, actions) {
  const seen = new Set();
  const out = [];
  for (const a of actions) {
    const key = a.kind === 'discard' ? `discard:${typeOf(a.tile)}` : `${a.kind}:${a.tile}:${(a.tiles || []).map(typeOf).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ action: a, label: actionLabel(view, a) });
  }
  return out;
}

export function agentSystem(rules) {
  return `你正在打一桌四人麻将，你是其中一家。目标：让自己的累计分尽可能高。

【怎么回答】
每次你会看到当前局面和一张编号的合法动作表。从表里选一个编号。
只输出一行 JSON，不要输出任何别的文字：
{"choice": 编号, "why": "不超过 25 个字的理由"}

【提醒】
表里的动作都是合法的，不在表里的不能做。
概念一律按下面这份本桌规则理解，不要套用日本麻将或其他地方玩法。

===== 本桌规则（以此为准）=====
${rules}`;
}

export function agentPrompt(view, seat, list) {
  return [
    '【当前局面】',
    describeSeat(view, seat),
    '',
    '【合法动作】',
    ...list.map((c, i) => `${i + 1}. ${c.label}`),
    '',
    '选一个编号，按格式输出 JSON。',
  ].join('\n');
}

/** 从模型回答里取出编号。容忍代码块包裹、前后多余文字；取不到返回 null。 */
export function parseChoice(text, n) {
  const s = String(text || '');
  let choice = null;
  let why = '';
  const m = s.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      choice = Number(j.choice);
      why = String(j.why || '').slice(0, 60);
    } catch { /* 下面按数字兜底 */ }
  }
  if (!Number.isInteger(choice)) {
    const d = s.match(/"?choice"?\s*[:：]\s*(\d+)/) || s.match(/^\s*(\d+)\s*$/);
    if (d) choice = Number(d[1]);
  }
  return Number.isInteger(choice) && choice >= 1 && choice <= n ? { index: choice - 1, why } : null;
}

/**
 * 造一个异步策略函数：(state, seat) => Promise<action>。
 * llm = { provider, key, baseUrl, model, timeoutMs }；onDecision 用来记日志。
 */
export function makeAgentPolicy({ llm, rules, onDecision = () => {} }) {
  const system = agentSystem(rules);
  return async function agentPolicy(state, seat) {
    const view = visibleState(state, seat);
    const actions = legalActions(state, seat);
    const list = choiceList(view, actions);
    if (list.length === 1) return list[0].action;           // 只有一种选择，不用问

    const prompt = agentPrompt(view, seat, list);
    const record = { seat, options: list.map((c) => c.label), attempts: [] };
    let messages = [{ role: 'user', content: prompt }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const t0 = performance.now();
      try {
        const reply = await ask({ ...llm, system, messages });
        const ms = Math.round(performance.now() - t0);
        const parsed = parseChoice(reply, list.length);
        record.attempts.push({ ms, reply: reply.slice(0, 300), ok: !!parsed });
        if (parsed) {
          Object.assign(record, { chosen: list[parsed.index].label, why: parsed.why, fallback: false });
          onDecision(record);
          return list[parsed.index].action;
        }
        messages = [...messages, { role: 'assistant', content: reply },
          { role: 'user', content: `没有读到有效编号。只能从 1 到 ${list.length} 里选，只输出一行 JSON：{"choice": 编号, "why": "理由"}` }];
      } catch (e) {
        record.attempts.push({ ms: Math.round(performance.now() - t0), error: e.message.slice(0, 200), ok: false });
      }
    }
    const action = aiChoose(state, seat);
    Object.assign(record, { chosen: actionLabel(view, action), why: '', fallback: true });
    onDecision(record);
    return action;
  };
}

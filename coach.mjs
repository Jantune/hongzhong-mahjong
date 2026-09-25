// 把牌局状态和引擎评估序列化成提示词。
//
// 分工是刻意的：
//   system   = 本桌规则（复用玩法说明的原文）+ 角色约束。永不变，可被缓存。
//   messages = 每次提问时由代码自动拼的局面快照 + 引擎数字 + 玩家的问题。
//
// 为什么把规则放进去：这是地方变体加本桌自定口径，模型对"武汉麻将"只有模糊印象，
// 不会知道这一桌屁胡必须 2/5/8 做将、胡家开门不加倍、只有下家能吃、屁胡最多一张赖子当万能牌。
// 缺了这些它会用听起来很在行的错理由去解释引擎算对的结论，比不解释更糟。
//
// 为什么还要塞引擎的数字：大模型算向听和进张一定会错，而我们手里的数字是经过
// 22,255 个局面交叉验证的。让它做翻译，不做推导。

import { NAMES } from './game.mjs';
import { xiangtingText, shantenLabel } from './advisor.mjs';

const SEAT_NAMES = ['南家（你）', '东家', '北家', '西家'];

// 这段提示词刻意写成纯文本：提示词本身用 Markdown（## 标题、** 加粗、- 列表），
// 模型就会照着用 Markdown 回答，而界面是按纯文本显示的。
const ROLE = `你是这桌麻将的陪练。玩家会问你当前这手牌该怎么打。

【输出格式】
只输出纯文本，界面不渲染 Markdown。不要用星号加粗、井号标题、横线或数字列表、表格、代码块、引用符号。
要分点就分段，每段开头直接说是哪张牌，段与段之间空一行。

【你要产出什么】
玩家已经看得到引擎那张表（向听、有效牌数、剩余张数、风险等级）。把那些数字复述一遍不算回答，那是他已经知道的东西。

判断自己答得合不合格，用这一条：把回答里所有来自那张表的数字划掉，剩下的内容如果还有价值，就合格；如果划完什么都不剩，就是废话，重写。

他想知道的是表上看不出来的那一层：这手牌具体长什么样，为什么是这张最该打。所以回答里至少要出现：

具体牌名。哪几张搭在一起成形了、哪几张是孤张、推荐打的那张为什么最没用（跟谁都不搭？重复了？还是所在的那门已经够了？）

将的处境。屁胡必须 2/5/8 做将，所以要说清楚现在将在哪、是稳的还是悬的、这一打会不会动到它。

落选项差在哪。别只说"其他的稍慢"，要说清楚是断了将、拆了搭子，还是纯粹进张少。但不要为了凑理由编出不存在的差别。判断两张牌有没有差别，要比较打掉各自之后剩下的手牌能进哪些牌：进的牌完全一样，那场上某张牌少了一张也同样影响两边，不构成差别。两张牌如果牌型地位一样（比如都是只能碰的孤张字牌），就直说它们地位相同，差别只在表里给的剩余张数或有效牌种数，引用那个数，别硬说其中一张"还能连上什么"。牌型上真的等价时，可以提一句场上的安全度（谁打过、谁在推），那才是剩下的区别。宁可说"这两张其实差不多"，也不要编。

【数字与牌理的分工】
数字不要自己算：向听、有效牌数、剩余张数一律用引擎给的，你算不准。
牌理要你自己讲：手牌里哪几张能组成什么、缺什么、打掉会断什么，这些是你看牌就能说清的，正是你该做的事。别因为"不要自己推算"就不敢分析牌型。

【其他】
下面没给到的信息（别人的暗牌、牌墙顺序）直说不知道，不要猜。
引擎的推荐只按进张速度排序，不考虑防守。玩家问安全就用"放炮风险"和"场上剩余"回答。
概念一律落在本桌规则上（2/5/8 将、皮子、赖子、4 点起收、封顶、门前清的软屁胡（用了赖子）只能自摸不能捉铳、硬屁胡门清也能捉铳——吃碰明杠才算开口，暗杠皮杠赖杠不算），不要套用日本麻将或其他地方玩法。
中文，口语，不绕弯子。说完就停，不要在结尾反问"你选哪个"之类的话。
引擎给的是建议，不是"唯一合法的下法"。只有当玩家主动问"能不能换个打法、能不能先不这么做"时，才去讨论替代方案：先按规则判可行性，可行就说可行，再讲代价；不要因为引擎推荐了 A 就回答"必须 A"。没问的时候不用主动提替代方案。典型例子：皮子在胡牌前必须杠掉，但"什么时候杠"可以自己选，留着晚点再杠（比如听牌后搏杠上开花）合规，只是期间不能胡、进张也慢。`;

/**
 * 取页面上那份玩法说明原文当规则，保证玩家和模型读的是同一份。
 *
 * 按 DOM 结构逐块取，不用 innerText：规则弹窗平时是关着的，而关闭的 <dialog>
 * 不参与渲染，innerText 此时会退化成 textContent，把所有块级元素挤成一行
 * （"本桌规则落子之前…"）。逐块取并自己加换行，任何浏览器下结果都一样。
 */
export function rulesText(doc = globalThis.document) {
  const card = doc?.querySelector?.('.drawer-card');
  if (!card) return '';
  const out = [];
  for (const el of card.children) {
    if (el.tagName === 'BUTTON') continue;                 // 关闭按钮的 ×
    if (el.classList?.contains('drawer-foot')) continue;   // 页脚跟规则无关
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    out.push(/^H[1-6]$/.test(el.tagName) ? `【${text}】` : text);
  }
  return out.join('\n');
}

/**
 * 提示词已经要求纯文本，这里是兜底：模型偶尔还是会漏出 Markdown 记号，
 * 显示前把最常见的几种去掉，只留文字。不做渲染，也不动正文里的普通星号以外的字符。
 */
export function plainText(s) {
  return String(s || '')
    .replace(/^```[^\n]*\n?/gm, '')              // 代码块围栏
    .replace(/\*\*(.+?)\*\*/g, '$1')             // **加粗**
    .replace(/__(.+?)__/g, '$1')                 // __加粗__
    .replace(/`([^`\n]+)`/g, '$1')               // `行内代码`
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // # 标题
    .replace(/^\s{0,3}>\s?/gm, '')               // > 引用
    .replace(/^\s*[-*+]\s+/gm, '')               // - 列表
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')          // --- 分隔线
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildSystem(doc) {
  const rules = rulesText(doc);
  return `${ROLE}\n\n===== 本桌规则（以此为准）=====\n${rules}`;
}

function tileList(ids, view) {
  if (!ids?.length) return '无';
  return ids.map((id) => {
    const t = Math.floor(Number(id) / 4);
    const tag = t === 31 || t === view.indicatorType ? '(皮)' : t === view.joker ? '(赖)' : '';
    return `${NAMES[t]}${tag}`;
  }).join(' ');
}

function meldsOf(view, p) {
  const out = [];
  for (const m of view.melds[p] || []) {
    const kind = { chi: '吃', pong: '碰', kong: '杠' }[m.kind] || m.kind;
    out.push(`${kind}[${(m.tiles || []).map((id) => NAMES[Math.floor(Number(id) / 4)]).join('')}]${m.open ? '' : '(暗)'}`);
  }
  for (const k of view.specialKongs[p] || []) {
    out.push(`${k.kind === 'joker' ? '赖杠' : '皮杠'}[${NAMES[Math.floor(Number(k.tile) / 4)]}]`);
  }
  return out.length ? out.join(' ') : '无';
}

/** 一屏能读完的局面快照。 */
export function boardSummary(view) {
  const lines = [];
  lines.push(`第 ${view.round} 局，庄家 ${SEAT_NAMES[view.dealer]}，封顶 ${view.rules?.cap}，牌墙还剩 ${view.wall} 张。`);
  lines.push(`指示牌 ${NAMES[view.indicatorType]} → 皮子是「${NAMES[view.indicatorType]}」和「红中」，赖子是「${NAMES[view.joker]}」。`);
  lines.push('');
  lines.push(`你的手牌：${tileList(view.hands[0], view)}`);
  lines.push(`你的副露：${meldsOf(view, 0)}`);
  lines.push('');
  for (let p = 1; p < 4; p += 1) {
    const river = (view.discards[p] || []).slice(-6);
    lines.push(`${SEAT_NAMES[p]}：副露 ${meldsOf(view, p)}；手牌 ${view.hands[p].length} 张；最近打出 ${tileList(river, view)}`);
  }
  const myRiver = (view.discards[0] || []).slice(-6);
  lines.push(`你最近打出：${tileList(myRiver, view)}`);
  lines.push(`各家累计分：${view.scores.map((s, i) => `${SEAT_NAMES[i]} ${s}`).join('，')}`);
  if (view.pending) {
    lines.push('');
    lines.push(`现在 ${SEAT_NAMES[view.pending.from]} 打出了 ${tileList([view.pending.tile], view)}，轮到你决定要不要吃/碰/杠。`);
  }
  return lines.join('\n');
}

/** 引擎评估。这些数字是权威的，模型只能引用不能改。 */
export function adviceSummary(adv) {
  if (!adv) return '（引擎这一手没有给出评估）';
  const lines = [];
  if (adv.mode === 'discard') {
    lines.push(`引擎推荐：打 ${NAMES[Math.floor(Number(adv.headlineTile) / 4)]}`);
    lines.push('候选（按进张速度排序，不含防守考量）：');
    for (const r of adv.rows) {
      lines.push(`  ${NAMES[r.type]}：打完 ${shantenLabel(r)}，有效牌 ${r.uk.kinds} 种，` +
        `这张牌场上还剩 ${r.danger.live} 张，放炮风险${r.danger.label}${r.recommended ? '  ← 推荐' : ''}`);
    }
  } else if (adv.mode === 'call') {
    lines.push(`引擎建议：${adv.headline}`);
    for (const r of adv.rows) {
      lines.push(`  ${r.label}：之后 ${xiangtingText(r.shanten)}，${r.gain >= 1 ? `快 ${Math.round(r.gain)} 步` : '没变快'}`);
    }
  } else {
    lines.push(`引擎建议：${adv.headline}`);
    if (adv.detail) lines.push(adv.detail);
  }
  if (adv.warnings?.length) {
    lines.push('');
    lines.push('引擎的硬性提醒：');
    for (const w of adv.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export const DEFAULT_QUESTION = '为什么建议这样打？简单说说理由。';

/** 拼成一条 user 消息。玩家只需要提供 question，局面部分全自动。 */
export function buildQuestion(view, adv, question) {
  return [
    '【当前局面】',
    boardSummary(view),
    '',
    // 这里刻意不写"请直接引用"——那会让模型把表念一遍就交差。
    // 数字是给它当事实依据的，不是给它当答案的。
    '【引擎评估：以下数字玩家已经在界面上看到了，拿去当依据，不要复述】',
    adviceSummary(adv),
    '',
    '【我的问题】',
    (question || '').trim() || DEFAULT_QUESTION,
  ].join('\n');
}

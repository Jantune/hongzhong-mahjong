import {
  createGame,
  nextRound,
  legalActions,
  applyAction,
  visibleState,
  validateState,
} from './game.mjs';

import { makePolicy, PROFILES } from './strategies_real.mjs';
import { advise, xiangtingText, shantenLabel } from './advisor.mjs';
import { PROVIDERS, DEFAULT_PROVIDER, providerOf, ask, probeProxy, testConnection, describeTarget, endpointPreview } from './llm.mjs';
import { buildSystem, buildQuestion, DEFAULT_QUESTION, plainText } from './coach.mjs';

import { tileMarkup, TILE_NAMES } from './tiles.mjs';
import { audio } from './audio.mjs';

// 电脑对手分三档，每家单独设，存在 localStorage 的 hz.ai.seat.<座位号> 里。
// 三档都以精算的向听—进张评估为底子（只求最快胡牌、不避炮）：
//   困难 = 精算 + 碰碰胡不折价、七对折价 0.5（锦标赛里对精算名次提前约 0.2，见 README 4.5）；
//   激情 = 困难 + 最后一张皮子在 1 向听时才杠、搏杠上开花（杠开多六成，强度与困难相当）；
//   简单 = 困难 + 温和失误：约 55% 的出牌在「打完向听相同」的牌里改打次优那张
//          （少进几张牌，但不会为失误退一步），强度约为困难的七成。
// 你自己的托管固定用纯精算，不给选。
const HARD_PROFILE = PROFILES.Hard;
const AI_POLICIES = {
  Easy: { label: '简单', policy: makePolicy({ ...HARD_PROFILE, blunder: 0.55, blunderSameShanten: true }) },
  Hard: { label: '困难', policy: makePolicy(HARD_PROFILE) },
  Passion: { label: '激情', policy: makePolicy({ ...HARD_PROFILE, holdLastSkin: true, holdSkinMaxXt: 1 }) },
};
const DEFAULT_AI = 'Hard';
const HOSTED_POLICY = makePolicy('Efficient');   // 托管固定用纯精算
const AI_SEATS = [1, 2, 3];      // 只有三家对手可选
// 旧版存的是策略名（稳健 / 精算），换成新档位
const LEGACY_AI = { Efficient: 'Hard', Guarded: 'Hard' };

const SEATS = [
  { name: '南家', place: 'south', short: '南' },
  { name: '东家', place: 'east', short: '东' },
  { name: '北家', place: 'north', short: '北' },
  { name: '西家', place: 'west', short: '西' },
];

const $ = (id) => document.getElementById(id);
const handRoot = $('hand');
const meldRoot = $('meld');
const actionRoot = $('actions');
const tableRoot = $('table') || document.querySelector('.table');
const resultRoot = $('result');
const statusRoot = $('status');
const logRoot = $('log');

const capRoot = $('cap');
const rulesRoot = $('rules');
const drawerRoot = $('drawer');
const closeRulesRoot = $('closeRules');
const autoRoot = $('autoplay');
const adviceRoot = $('advice');
const adviceToggle = $('advice-toggle');
const llmToggle = $('llm-toggle');
const askRoot = $('ask');
const askHistoryRoot = $('ask-history');
const askInput = $('ask-input');
const askSend = $('ask-send');
const askCancel = $('ask-cancel');
const askStatus = $('ask-status');
const askOut = $('ask-out');
const llmDialog = $('llm-dialog');
const soundDialog = $('sound-dialog');
let coachHistory = [];
let askController = null;
let proxyProviders = null;
const AUDIO_KEYS = { voice: 'hz.audio.voice', sfx: 'hz.audio.sfx', ambience: 'hz.audio.ambience', volume: 'hz.audio.volume' };

const store = {
  get(k, fallback = '') {
    try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* 隐私模式下写不进去，忽略 */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch { /* 同上 */ }
  },

};

const LLM_KEYS = { provider: 'hz.llm.provider', model: 'hz.llm.model', key: 'hz.llm.key', baseUrl: 'hz.llm.baseUrl', viaProxy: 'hz.llm.viaProxy', enabled: 'hz.llm.enabled' };
function llmConfig() {
  const provider = store.get(LLM_KEYS.provider, DEFAULT_PROVIDER);
  const p = providerOf(provider);
  return { provider: PROVIDERS[provider] ? provider : DEFAULT_PROVIDER, model: store.get(LLM_KEYS.model, p.models[0] || ''), key: store.get(LLM_KEYS.key), baseUrl: store.get(LLM_KEYS.baseUrl), viaProxy: store.get(LLM_KEYS.viaProxy) === '1' };
}
function setAskStatus(text, error = false) {
  if (!askStatus) return;
  askStatus.hidden = !text;
  askStatus.textContent = text;
  askStatus.classList.toggle('is-error', error);
}
function renderCoachHistory() {
  if (!askHistoryRoot) return;
  askHistoryRoot.innerHTML = coachHistory.map((m) => `<div class="ask-message ${m.role === 'user' ? 'is-user' : 'is-assistant'}"><span>${m.role === 'user' ? '你' : '陪练'}</span><p></p></div>`).join('');
  // 用户那条显示原话；发给模型的 content 里拼了整段局面，不该出现在对话气泡里
  [...askHistoryRoot.querySelectorAll('p')].forEach((el, i) => { el.textContent = coachHistory[i].display ?? coachHistory[i].content; });
  askHistoryRoot.hidden = coachHistory.length === 0;
  askHistoryRoot.scrollTop = askHistoryRoot.scrollHeight;
}
function resetCoach() {
  if (askController) askController.abort();
  askController = null;
  coachHistory = [];
  renderCoachHistory();
  setAskStatus('');
  if (askOut) { askOut.hidden = true; askOut.textContent = ''; }
  if (askCancel) askCancel.hidden = true;
  if (askSend) askSend.disabled = false;
}
function renderLlmProvider() {
  const select = $('llm-provider');
  if (!select) return;
  const config = llmConfig();
  select.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}"${id === config.provider ? ' selected' : ''}>${p.label}</option>`).join('');
  const p = providerOf(config.provider);
  $('llm-model').value = config.model;
  $('llm-key').value = config.key;
  $('llm-base').value = config.baseUrl;
  $('llm-proxy').checked = config.viaProxy;
  $('llm-key-url').hidden = !p.keyUrl;
  $('llm-key-url').href = p.keyUrl || '#';
  const proxyRow = $('llm-proxy-row');
  if (proxyRow) { proxyRow.hidden = !proxyProviders; if (!proxyProviders) $('llm-proxy').checked = false; }
  renderLlmPreview();
  setTestResult('');
}
/** 设置弹窗里当前填的值（还没保存），测试连接和地址预览都用它。 */
function formConfig() {
  const viaProxy = $('llm-proxy').checked && !!proxyProviders;
  // 走转发时密钥照样带上：服务端配了环境变量就用服务端的，没配才用这里填的
  return { provider: $('llm-provider').value, model: $('llm-model').value.trim(), key: $('llm-key').value, baseUrl: $('llm-base').value.trim(), viaProxy };
}
function renderLlmPreview() {
  const c = formConfig();
  const p = providerOf(c.provider);
  $('llm-base').placeholder = p.baseUrl ? `留空用官方地址；例：${p.baseExample || p.baseUrl}` : `必填；例：${p.baseExample || ''}`;
  const preview = $('llm-preview');
  if (!preview) return;
  const url = endpointPreview(c.provider, c.baseUrl, c.model);
  preview.textContent = c.viaProxy ? `实际请求：本地转发 → ${url || '（未填地址）'}` : url ? `实际请求：${url}` : '实际请求：还没有填接口地址';
}
let testController = null;
function setTestResult(text, kind = '') {
  const el = $('llm-test-result');
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.className = `llm-test-result${kind ? ` is-${kind}` : ''}`;
}
/** 已等待秒数的计时器：请求挂着时让人知道它还活着、连的是哪里。 */
function startTicker(render) {
  const t0 = Date.now();
  render(0);
  const id = setInterval(() => render(Math.floor((Date.now() - t0) / 1000)), 1000);
  return () => clearInterval(id);
}
async function runConnectionTest() {
  if (testController) { testController.abort(); return; }
  const c = formConfig();
  const button = $('llm-test');
  testController = new AbortController();
  button.textContent = '停止测试';
  const stop = startTicker((s) => setTestResult(`测试中…… ${s} 秒 · ${describeTarget(c)}`));
  try {
    const { ms, reply } = await testConnection({ ...c, signal: testController.signal });
    setTestResult(`连通。往返 ${(ms / 1000).toFixed(1)} 秒，模型回复：${reply.slice(0, 40)}`, 'ok');
  } catch (error) {
    if (error?.name === 'AbortError') setTestResult('已停止测试');
    else setTestResult(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    stop();
    testController = null;
    button.textContent = '测试连接';
  }
}
async function enableLlm() {
  if (!llmToggle?.checked) { askController?.abort(); askRoot.hidden = true; return; }
  askRoot.hidden = false;
  if (!proxyProviders) proxyProviders = await probeProxy();
  renderLlmProvider();
}
async function sendQuestion() {
  if (!llmToggle?.checked || askController) return;
  const config = llmConfig();
  const state = visibleState(game, 0);
  let adv = null;
  try { adv = advise(state, 0); } catch { /* coach can still describe the board */ }
  const question = askInput?.value.trim() || DEFAULT_QUESTION;
  const content = buildQuestion(state, adv, question);
  if (askInput) askInput.value = '';
  coachHistory.push({ role: 'user', content, display: question });
  renderCoachHistory();
  askController = new AbortController();
  askSend.disabled = true;
  askCancel.hidden = false;
  if (askOut) { askOut.hidden = true; askOut.textContent = ''; }
  const viaProxy = config.viaProxy && !!proxyProviders;
  const target = describeTarget({ ...config, viaProxy });
  const stopTicker = startTicker((s) => setAskStatus(`正在思考…… ${s} 秒 · ${target}`));
  try {
    const reply = await ask({ provider: config.provider, key: config.key, model: config.model, system: buildSystem(document), messages: coachHistory.map(({ role, content }) => ({ role, content })), baseUrl: config.baseUrl, signal: askController.signal, viaProxy });
    stopTicker();
    coachHistory.push({ role: 'assistant', content: plainText(reply) });
    renderCoachHistory();
    setAskStatus('');
  } catch (error) {
    stopTicker();
    // 没拿到回答就撤回这条提问并放回输入框，否则重试会在历史里留下两条连续的 user
    coachHistory.pop();
    renderCoachHistory();
    if (askInput && !askInput.value) askInput.value = question === DEFAULT_QUESTION ? '' : question;
    if (error?.name === 'AbortError') setAskStatus('已取消');
    else setAskStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    askController = null;
    askSend.disabled = false;
    askCancel.hidden = true;
  }
}
// 每家单独设策略。策略是纯函数（只读 state），中途换人不用重开牌局，下一次决策即生效。
const AI_SEAT_KEY = (p) => `hz.ai.seat.${p}`;
function aiNameOf(p) {
  const raw = store.get(AI_SEAT_KEY(p), DEFAULT_AI);
  const v = LEGACY_AI[raw] || raw;
  return Object.hasOwn(AI_POLICIES, v) ? v : DEFAULT_AI;
}
const aiPolicy = (p) => (p === 0 ? HOSTED_POLICY : AI_POLICIES[aiNameOf(p)].policy);

let game;
let generation = 0;
let timer = null;
let selectedTile = null;
let lastError = '';
let autoplay = false;
let shownResult = null;
const seedFromUrl = readSeed();

function readSeed() {
  const raw = new URLSearchParams(location.search).get('seed');
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? (n | 0) : null;
}

function typeOf(id) {
  return Math.floor(id / 4);
}

function nameOfType(type) {
  return TILE_NAMES[type] || '未知';
}

function typeOfIndicator(state) {
  return typeOf(state.indicator);
}

function isSkin(state, id) {
  const t = typeOf(id);
  return t === 31 || t === typeOfIndicator(state);
}

function isJoker(state, id) {
  return typeOf(id) === state.joker;
}

function tileName(state, id) {
  return nameOfType(typeOf(id));
}

function seatName(p) {
  return SEATS[p]?.name || `第 ${p + 1} 家`;
}

function tileButtonMarkup(state, id, action, selected, justDrawn = false) {
  const isSkinTile = isSkin(state, id);
  const isJokerTile = isJoker(state, id);
  const disabled = !action;
  let label = `${disabled ? '不可操作' : '选择'} ${tileName(state, id)}`;
  if (isSkinTile) label = `皮牌 ${tileName(state, id)}${action ? '（可开皮杠）' : '（不可打出）'}`;
  else if (isJokerTile) label = `赖子 ${tileName(state, id)}${action ? '（可开赖杠或打出）' : ''}`;
  return `<button class="tile-button ${selected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''} ${justDrawn ? 'just-drawn' : ''}" data-action="select-tile" data-tile-id="${id}" aria-label="${label}" ${disabled ? 'disabled' : ''}>${tileMarkup(state, id, { selected, disabled })}</button>`;
}

function actionLabel(action, state) {
  if (!action) return '';
  const tile = action.tile === undefined ? '' : tileName(state, action.tile);
  if (action.kind === 'win') return action.selfDraw || !state.pending ? '和牌（自摸）' : '和牌';
  if (action.kind === 'discard') return `打出 ${tile}`;
  if (action.kind === 'pass') return '过';
  if (action.kind === 'pong') return `碰 ${tile}`;
  if (action.kind === 'chi') {
    const consume = action.tiles?.length ? `（${action.tiles.map((id) => tileName(state, id)).join('、')}）` : '';
    return `吃 ${tile}${consume}`;
  }
  if (action.kind === 'concealedKong') return `暗杠 ${tile}`;
  if (action.kind === 'kong') return `杠 ${tile}`;
  if (action.kind === 'skinKong') return `皮杠 ${tile}`;
  if (action.kind === 'jokerKong') return `赖杠 ${tile}`;
  if (action.kind === 'addedKong') return `蓄杠 ${tile}`;
  if (action.kind === 'exposedKong') return `明杠 ${tile}`;
  return action.kind || '操作';
}

function factorText(factors = []) {
  return factors.map((f) => `${f.name} ×${f.multiplier}`).join(' · ') || '无额外倍数';
}

function formatDelta(n) {
  if (!n) return '0';
  return n > 0 ? `+${n}` : `${n}`;
}

function clearTimer() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

function schedule(fn, delay = 500) {
  clearTimer();
  const token = generation;
  timer = window.setTimeout(() => {
    timer = null;
    if (token !== generation) return;
    fn();
  }, delay);
}

// 行牌节奏。固定间隔会让三家像节拍器，真人打牌是有快有慢的：多数牌顺手就打，
// 偶尔卡一下长考。这里抖动的只是"等多久"，动作本身在计时开始之前就已经算完了，
// 所以这些随机数不影响任何一手牌的走向，牌局仍然只由种子决定。
//
// 时间也不能平摊：一手牌之间要等三家各自决定吃不吃碰不碰，那三下多半都是"过"，
// 桌上什么都不会发生。过只给一个很短的停顿，把预算留给真正有动作的那一步。
const CALL_KINDS = new Set(['chi', 'pong', 'exposedKong', 'skinKong', 'jokerKong', 'concealedKong', 'addedKong']);
const PACE = { pass: 90, call: 300, discard: 420 };
// 节奏固定为「从容」（原来的快局 1 / 从容 3 / 慢局 5 三档已取消）
const PACE_SPEED = 3;

// 有人声时，出牌和吃碰杠要等上一段播报念完再动，否则下一家的落牌会把牌名打断。
// "过"桌上没有动静，不用等；等到真正出声的那一手自然会等。
function pacedDelay(action) {
  const ms = thinkDelay(action);
  if (!action || action.kind === 'pass') return ms;
  const remaining = audio.voiceRemainingMs();
  return remaining > 0 ? Math.max(ms, Math.round(remaining) + 150) : ms;
}

// ---- 中间那张「刚打出的牌」：从出牌那家飞过来，旁边的小三角一直指着他 ----
// 同一张牌只画一次：渲染很频繁（别家回应过牌也会重画），每次重建会把飞牌动画打断。
let lastPlayKey = null;
function renderLastPlay(state, tile, player) {
  const root = $('last-play');
  if (!root) return;
  if (tile === undefined || player === undefined) {
    lastPlayKey = null;
    root.innerHTML = '';
    delete root.dataset.from;
    return;
  }
  const key = `${state.round}:${player}:${tile}`;
  if (key === lastPlayKey) return;
  lastPlayKey = key;
  const place = SEATS[player]?.place || '';
  root.dataset.from = place;
  root.innerHTML = `<span class="last-play-tile">${tileMarkup(state, tile)}<i class="lp-arrow" aria-hidden="true"></i></span>`
    + `<span class="last-play-label">${seatName(player)}<b>打出 ${tileName(state, tile)}</b></span>`;
  flyFromSeat(root.querySelector('.last-play-tile'), player);
}
/** 让牌从出牌那家的座位滑到桌子中间。系统开了「减少动态效果」就不飞，只留三角。 */
function flyFromSeat(el, player) {
  const seat = $(`p${player}`);
  if (!el || !seat || !el.animate) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const a = seat.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  if (!a.width || !b.width) return;   // 页面不可见或还没布局好
  const dx = a.left + a.width / 2 - (b.left + b.width / 2);
  const dy = a.top + a.height / 2 - (b.top + b.height / 2);
  el.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(.55)`, opacity: 0.35 },
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
  ], { duration: 280, easing: 'cubic-bezier(.2, .75, .25, 1)' });
}

function thinkDelay(action) {
  const speed = PACE_SPEED;
  const kind = !action ? 'discard' : action.kind === 'pass' ? 'pass' : CALL_KINDS.has(action.kind) ? 'call' : 'discard';
  let ms = PACE[kind] * speed;
  if (kind === 'pass') {
    ms *= 0.7 + Math.random() * 0.6;
  } else {
    // 常态是基准的 0.7~1.15 倍；大约每七手来一次 1.7~2.4 倍的长考
    ms *= Math.random() < 0.15 ? 1.7 + Math.random() * 0.7 : 0.7 + Math.random() * 0.45;
  }
  return Math.round(ms);
}

function actionForTile(actions, id) {
  return actions.find((a) => a.tile === id && ['discard', 'skinKong', 'jokerKong', 'concealedKong'].includes(a.kind)) || null;
}

function playerActions(state) {
  try {
    return legalActions(game, 0) || [];
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return [];
  }
}

function pendingSource(state) {
  if (!state.pending) return null;
  if (state.pending.from !== undefined && state.pending.from !== null) return Number(state.pending.from);
  // The fallback keeps the UI compatible with response objects that omit the
  // source. For a discard, the physical tile uniquely identifies its river;
  // a rob-kong keeps the acting seat in turn. This also works when responses
  // starts as {}.
  if (state.pending.kind === 'discard') {
    const tile = state.pending.tile;
    for (let p = 0; p < 4; p += 1) {
      if (state.discards?.[p]?.at(-1) === tile) return p;
    }
    return (state.turn + 3) % 4;
  }
  return state.turn;
}

/** 别人出牌后轮到你回应，而且真有得选（能吃 / 碰 / 杠 / 胡）。只有「过」时会自动替你过，界面上不该闪一下。 */
function humanMustDecide(state) {
  if (!state.pending || pendingSeat(state) !== 0) return false;
  return playerActions(state).some((a) => a.kind !== 'pass');
}

function pendingSeat(state) {
  if (!state.pending) return null;
  const source = pendingSource(state);
  // legalActions is the authoritative pending-response contract. It handles
  // both an empty responses object and one containing only replied seats.
  for (let p = 0; p < 4; p += 1) {
    if (p === source) continue;
    try {
      if ((legalActions(game, p) || []).length) return p;
    } catch {
      // The normal render path reports action errors through playerActions.
    }
  }
  return null;
}

function renderHand(state, actions) {
  if (!handRoot) return;
  // Keep the engine's physical order intact. Sorting this render-only copy makes
  // the hand readable while lastDraw still identifies the actual drawn tile.
  const drawn = !state.pending && state.turn === 0 && state.lastDrawPlayer === 0 ? state.lastDraw : null;
  const hand = [...(state.hands[0] || [])].sort((a, b) => Number(a === drawn) - Number(b === drawn) || typeOf(a) - typeOf(b) || a - b);
  const handActions = actions.filter((a) => ['discard', 'skinKong', 'jokerKong', 'concealedKong'].includes(a.kind));
  const actionById = new Map();
  for (const a of handActions) {
    if (a.tile !== undefined && !actionById.has(a.tile)) actionById.set(a.tile, a);
  }
  handRoot.innerHTML = hand.map((id) => tileButtonMarkup(state, id, actionById.get(id), selectedTile === id, id === drawn)).join('');
  handRoot.classList.toggle('hand-disabled', !actions.length);
  if (!hand.length) handRoot.innerHTML = '<span class="empty-note">手牌已离手</span>';
}

function meldMarkup(state, p, compact = false) {
  const melds = state.melds?.[p] || [];
  const specials = state.specialKongs?.[p] || [];
  const groups = [];
  for (const m of melds) {
    const tiles = (m.tiles || []).map((id) => tileMarkup(state, id, { compact })).join('');
    const kind = m.kind === 'pong' ? '碰' : m.kind === 'chi' ? '吃' : m.kind === 'kong' ? (m.open ? '明杠' : '暗杠') : m.kind;
    groups.push(`<span class="meld-group" title="${kind}"><b>${kind}</b>${tiles}</span>`);
  }
  for (const k of specials) {
    const kind = k.kind === 'joker' ? '赖杠' : k.kind === 'skin' ? '皮杠' : '特殊杠';
    groups.push(`<span class="meld-group special-meld" title="${kind}"><b>${kind}</b>${tileMarkup(state, k.tile, { compact })}</span>`);
  }
  return groups.join('') || '<span class="no-meld">门清</span>';
}

function riverMarkup(state, p) {
  const river = state.discards?.[p] || [];
  if (!river.length) return '<span class="no-river">暂无出牌</span>';
  return river.map((id) => `<span class="river-tile ${state.pending?.tile === id ? 'latest' : ''}" title="${tileName(state, id)}">${tileMarkup(state, id, { compact: true })}</span>`).join('');
}

function seatStatus(state, p) {
  if (state.phase === 'done') return p === state.result?.winner ? '和牌' : '';
  if (state.pending) return pendingSeat(state) === p ? '等待操作' : '';
  return state.turn === p ? '出牌中' : '';
}

function renderSeat(state, p) {
  const root = $(`p${p}`);
  if (!root) return;
  const seat = SEATS[p];
  const hand = state.hands?.[p] || [];
  const isHuman = p === 0;
  const isDone = state.phase === 'done';
  let handHtml = '';
  if (isHuman && !isDone) {
    handHtml = '';
  } else if (isDone) {
    const sorted = [...hand].sort((a, b) => typeOf(a) - typeOf(b) || a - b);
    handHtml = sorted.map((id) => tileMarkup(state, id, { compact: true })).join('');
  } else {
    handHtml = Array.from({ length: hand.length }, () => tileMarkup(state, null, { back: true, compact: true })).join('');
  }
  const titleBits = [
    `<span class="seat-name">${seat.name}</span>`,
    p === state.dealer ? '<span class="dealer-badge">庄</span>' : '',
    p === 0
      ? `<span class="human-badge">${autoplay ? `托管 · 精算` : '你'}</span>`
      : `<span class="ai-badge">${AI_POLICIES[aiNameOf(p)].label}</span>`,
    seatStatus(state, p) ? `<span class="turn-badge">${seatStatus(state, p)}</span>` : '',
  ].join('');
  const score = state.scores?.[p] ?? 0;
  root.classList.toggle('is-active', !!seatStatus(state, p));
  root.innerHTML = `
    <div class="seat-title">${titleBits}<span class="score">${score} 分</span>${isHuman && !isDone ? '' : `<span class="hand-count">${hand.length} 张</span>`}</div>
    <div class="opponent-hand ${isHuman && !isDone ? 'human-seat' : 'revealed-hand'}">${handHtml}</div>
    <div class="seat-melds">${meldMarkup(state, p, true)}</div>
    <div class="seat-river-label">牌河 <span>${state.discards?.[p]?.length || 0}</span></div>
    <div class="seat-river">${riverMarkup(state, p)}</div>`;
}

function renderCenter(state) {
  const indicatorType = typeOfIndicator(state);
  const skinName = nameOfType(indicatorType);
  const jokerName = nameOfType(state.joker);
  const indicator = $('indicator');
  if (indicator) {
    indicator.innerHTML = `<div class="sign-column"><span>指示 · 皮</span>${tileMarkup(state, state.indicator)}<strong>${skinName}</strong></div><div class="sign-column skin-sign"><span>皮子</span>${tileMarkup(state, 124)}<strong>红中</strong></div><div class="sign-column joker-sign"><span>赖子</span>${tileMarkup(state, state.joker * 4)}<strong>${jokerName}</strong></div>`;
  }
  $('round-number').textContent = `第 ${state.round} 局`;
  const wall = $('wall');
  // 王牌那几张永远摸不到，跟余牌并排显示，免得误以为还能摸到它们
  const dead = (state.deadWall || 0) + 1;   // 补牌区 + 那张指示牌
  if (wall) {
    wall.innerHTML = `余牌 <b>${state.wall}</b> 张 <span>· 王牌 ${dead} 张摸不到 · 封顶 ${state.rules?.cap ?? 50}</span>`;
  }
  const deadRoot = $('deadwall');
  if (deadRoot) {
    const backs = Array.from({ length: state.deadWall || 0 }, () => tileMarkup(state, null, { back: true, compact: true })).join('');
    deadRoot.innerHTML = `<div class="deadwall-head">王牌 · 摸不到 <b>${dead}</b> 张</div>`
      + `<div class="deadwall-row">${tileMarkup(state, state.indicator, { compact: true })}${backs}</div>`
      + `<p class="deadwall-note">翻开的这张是指示牌，其余 ${state.deadWall || 0} 张是杠后补牌用的。每开一个杠，牌墙尾部就有一张挪进王牌，可摸的牌少一张。</p>`;
  }
  const recent = state.log?.findLast(entry => entry?.type === 'discard');
  const tile = state.pending?.tile ?? recent?.tile;
  const player = state.pending?.from ?? recent?.player;
  renderLastPlay(state, tile, player);
  const status = statusRoot;
  if (status) {
    let text = '';
    if (state.phase === 'done') text = state.result?.type === 'draw' ? '荒庄' : `${seatName(state.result?.winner)} 和牌`;
    else if (state.pending) text = humanMustDecide(state) ? '等待你的选择' : '各家回应中';
    else if (state.turn === 0) text = autoplay ? '电脑代你行牌' : '轮到你出牌';
    else text = `${seatName(state.turn)}正在思考`;
    status.textContent = text;
  }
}

function renderActions(state, actions) {
  if (!actionRoot) return;
  const pendingHuman = !!state.pending && pendingSeat(state) === 0;
  // 只有「过」可选时不画按钮：continueGame 会在 0.2 秒后自动替你过
  const onlyPass = pendingHuman && !autoplay && !humanMustDecide(state);
  const nonDiscard = actions.filter((a) => a.kind !== 'discard' && !(onlyPass && a.kind === 'pass'));
  const discard = actions.filter((a) => a.kind === 'discard');
  const chiOptions = nonDiscard.filter((a) => a.kind === 'chi');
  const buttons = [];
  if (!pendingHuman && discard.length && selectedTile !== null) {
    const selectedAction = actionForTile(discard, selectedTile);
    if (selectedAction) buttons.push(`<button class="primary" data-action="commit-discard">打出 ${tileName(state, selectedTile)}</button>`);
  }
  for (const action of nonDiscard) {
    const actionIndex = actions.indexOf(action);
    const primary = ['win', 'skinKong', 'jokerKong', 'concealedKong', 'addedKong', 'exposedKong', 'kong'].includes(action.kind);
    const cls = primary ? 'primary' : 'secondary';
    const chiNo = action.kind === 'chi' ? chiOptions.indexOf(action) + 1 : 0;
    const details = action.kind === 'chi' && chiOptions.length > 1 ? `<small>第 ${chiNo} 组</small>` : '';
    buttons.push(`<button class="${cls}" data-action="game-action" data-action-index="${actionIndex}" data-kind="${action.kind}" data-tile-id="${action.tile ?? ''}" data-meld-index="${action.meldIndex ?? ''}" aria-label="${actionLabel(action, state)}">${actionLabel(action, state)}${details}</button>`);
  }
  // 一局结束后在牌桌上直接给出「下一局」：关掉结算回看牌桌之后，不必再绕回结算弹窗
  if (state.phase === 'done' && state.result) {
    const over = matchOver(state);
    const label = over ? '本场结束 · 查看排名' : state.result.type === 'draw' ? '下一局（庄家连庄）' : '下一局';
    buttons.push(`<button class="primary" data-action="next-round">${label}</button>`);
    buttons.push('<button class="secondary" data-action="open-result">查看本局结算</button>');
  }
  if (!buttons.length) {
    const note = state.phase === 'done' ? '本局已结束，下一局见。' : autoplay ? '已托管，随时可切回自己操作' : discard.length ? '点选手牌，再确认打出' : '等待其他玩家行牌';
    actionRoot.innerHTML = `<span class="action-note">${note}</span>`;
  } else {
    actionRoot.innerHTML = buttons.join('');
  }
  $('hand-hint').textContent = selectedTile !== null ? `已选 ${tileName(state, selectedTile)} · 回车确认 / Esc 取消` : state.pending && actions.some(a => a.kind !== 'pass') ? '可以响应桌上的这张牌' : '点选一张牌，再确认打出';
  document.querySelector('.hand-panel').classList.toggle('is-auto', autoplay);
}

// 离线建议面板。全部本地计算，不联网、不需要密钥。
function hideAdvice() {
  if (!adviceRoot) return;
  adviceRoot.hidden = true;
  adviceRoot.innerHTML = '';

}

/** 建议表"打完之后"一格的第二行：听牌列出听的牌，1 向听列出能进听的牌，各带场上剩余张数 */
function adviceTilesLine(r) {
  const fmt = (list) => {
    const total = list.reduce((s, x) => s + x.live, 0);
    const items = list.map((x) => `<span class="adv-tile${x.live === 0 ? ' is-dead' : ''}${x.ok === false ? ' is-noway' : ''}${x.selfOnly ? ' is-self' : ''}" title="${x.ok === false ? '牌型听了，但打点不够 4，胡不了' : x.selfOnly ? `只能自摸，别人打出来胡不了 · 场上还剩 ${x.live} 张` : `场上还剩 ${x.live} 张`}">${x.joker ? '赖子' : ''}${TILE_NAMES[x.t]}<b>${x.live}</b></span>`).join('');
    return `${items}<em>共 ${total} 张</em>`;
  };
  if (r.waits) {
    if (!r.waits.length) return '<span class="adv-label">暂时胡不了</span>';
    const ok = r.waits.filter((w) => w.ok);
    const label = !ok.length ? '听（打点不够 4）' : ok.every((w) => w.selfOnly) ? '听（只能自摸）' : '听';
    return `<span class="adv-label">${label}</span>${fmt(r.waits)}`;
  }
  if (r.next?.length) return `<span class="adv-label">进听</span>${fmt(r.next)}`;
  return `有效牌 ${r.uk.kinds} 种`;
}

function renderAdvice(state) {
  if (!adviceRoot) return;
  if (!adviceToggle?.checked || state.phase === 'done') return hideAdvice();
  const seat = pendingSeat(state);
  const ourDecision = (seat === 0 && humanMustDecide(state)) || (seat === null && !state.pending && state.turn === 0);
  if (!ourDecision) return hideAdvice();

  let adv = null;
  try {
    adv = advise(state, 0);
  } catch (error) {
    lastError = `建议计算失败：${error.message}`;
    return hideAdvice();
  }
  if (!adv || adv.mode === 'none') return hideAdvice();

  const head = adv.headlineTile !== undefined
    ? adv.headline.replace('{TILE}', tileMarkup(state, adv.headlineTile, { compact: true }))
    : adv.headline;

  let table = '';
  if (adv.mode === 'discard' && adv.rows.length) {
    // 进张数和向听放同一格：窄屏下四列放不下，而进张恰恰是排序依据，不能被藏掉。
    const body = adv.rows.map((r) => `<tr class="${r.recommended ? 'is-best' : ''}" data-action="select-tile" data-tile-id="${r.action.tile}" title="点一下就选中这张牌">
      <td>${tileMarkup(state, r.action.tile, { compact: true })}</td>
      <td>${shantenLabel(r)}<small>${adviceTilesLine(r)}</small></td>
      <td class="danger-${r.danger.rank}">${r.danger.label}<small>场上剩 ${r.danger.live}</small></td>
    </tr>`).join('');
    table = `<table class="advice-table"><thead><tr><th>打这张</th><th>打完之后</th><th>放炮风险</th></tr></thead><tbody>${body}</tbody></table>`;
  } else if (adv.mode === 'call' && adv.rows.length) {
    const body = adv.rows.map((r) => `<tr class="${r.recommended ? 'is-best' : ''}">
      <td>${r.label}</td>
      <td>${xiangtingText(r.shanten)}</td>
      <td>${r.gain >= 1 ? `快 ${Math.round(r.gain)} 步` : '没变快'}</td>
    </tr>`).join('');
    table = `<table class="advice-table"><thead><tr><th>选择</th><th>之后</th><th>效果</th></tr></thead><tbody>${body}</tbody></table>`;
  } else if (adv.mode === 'kong' && adv.waits?.length) {
    // 杠完听的牌：杠开能胡的也算能胡，不划掉
    const waits = adv.waits.map((w) => ({ ...w, ok: w.ok || w.gangKai }));
    table = `<p class="advice-waits">${adviceTilesLine({ waits })}</p>`;
  }

  const warn = adv.warnings.length
    ? `<ul class="advice-warn">${adv.warnings.map((w) => `<li>${w}</li>`).join('')}</ul>`
    : '';
  const kong = adv.kongNote ? `<p class="advice-kong">${adv.kongNote}</p>` : '';
  const foot = adv.mode === 'discard'
    ? `<p class="advice-foot">${adv.tied > 1 ? `前 ${adv.tied} 行完全一样好（向听、进张都相同），排第一只是先打孤张和幺九；` : ''}推荐只看进张速度，不避炮——想保守就挑风险低的那行。</p>`
    : '';

  adviceRoot.hidden = false;
  adviceRoot.innerHTML = `<div class="advice-head"><strong>${head}</strong><span>${adv.detail}</span></div>${warn}${table}${kong}${foot}`;

}

function payerFactors(state, p) {
  const melds = state.melds?.[p] || [];
  const specials = state.specialKongs?.[p] || [];
  const open = melds.some((meld) => !!meld.open);
  const normalKongs = melds.filter((meld) => ['kong', 'exposedKong', 'concealedKong', 'addedKong'].includes(meld.kind)).length;
  const skinKongs = specials.filter((kong) => kong.kind === 'skin' || kong.kind === 'skinKong').length;
  const jokerKongs = specials.filter((kong) => kong.kind === 'joker' || kong.kind === 'jokerKong').length;
  const L = (open ? 2 : 1) * (2 ** (normalKongs + skinKongs)) * (4 ** jokerKongs);
  return { open, normalKongs, skinKongs, jokerKongs, L };
}

function isWidePayment(score, labels, selfDraw) {
  if (selfDraw || score.sevenPairs || score.big || labels.some((label) => String(label).includes('七对'))) return true;
  const narrowOnly = new Set(['屁胡', '七对', '豪华七对', '硬胡']);
  return labels.some((label) => !narrowOnly.has(label));
}

function settlementInfo(state, result, score, winner, W, payments) {
  const cap = Number(result.cap ?? state.rules?.cap ?? 50);   // 按结算那一刻的封顶显示
  const labels = Array.isArray(score.labels) ? score.labels : [];
  const selfDraw = result.from === null || result.from === undefined;
  const wide = isWidePayment(score, labels, selfDraw);
  const scope = selfDraw ? '自摸：三家分别判断' : wide ? '七对 / 大胡：三家付款范围' : '屁胡点炮：仅点炮者';
  const derived = [0, 1, 2, 3].map((p) => {
    if (p === winner) return 0;
    const factors = payerFactors(state, p);
    const raw = W * factors.L;
    const inScope = wide || p === result.from;
    const reachesMinimum = raw >= 4;
    const capped = Math.min(cap, raw);
    const halfTop = W >= cap && !factors.open;
    const amount = inScope && reachesMinimum ? capped + (halfTop ? cap / 2 : 0) : 0;
    return { p, ...factors, raw, inScope, reachesMinimum, capped, halfTop, amount };
  });
  return { cap, selfDraw, wide, scope, rows: derived, payments };
}

function paymentReason(row, settlement) {
  if (!row.inScope) return '不在本牌型付款范围';
  if (!row.reachesMinimum) return '打点不足 4，本家免付';
  if (row.raw >= settlement.cap) {
    if (row.halfTop) return `封顶 ${settlement.cap}，未开口另加半顶 ${settlement.cap / 2}`;
    return `封顶 ${settlement.cap}，无需顶外加点`;
  }
  return `打点 ${row.raw}，未触顶`;
}

function seatHandsMarkup(state) {
  const winner = state.result?.winner;
  const rows = [0, 1, 2, 3].map((p) => {
    const isWinner = p === winner;
    const hand = (state.hands?.[p] || []).slice().sort((a, b) => typeOf(a) - typeOf(b) || a - b);
    const handTiles = hand.map((id) => tileMarkup(state, id, { compact: true })).join('');
    const melds = meldMarkup(state, p, true);
    return `<div class="result-player-hand ${isWinner ? 'winner-hand' : ''}">
      <div class="player-info">
        <span class="player-tag">${seatName(p)}${isWinner ? ' · 和' : ''}</span>
        <div class="player-melds">${melds}</div>
      </div>
      <div class="player-tiles">${handTiles || '<span class="no-hand">无手牌</span>'}</div>
    </div>`;
  }).join('');
  return `<div class="result-hands-section"><div class="section-title"><b>全家手牌</b><span>牌局结束，各家手牌明示</span></div><div class="result-hands-grid">${rows}</div></div>`;
}

function resultMarkup(state) {
  if (!state.result) return '';
  if (state.result.type === 'draw') {
    return `<div class="result-card draw-result"><div class="result-heading"><span>荒庄</span><span class="result-round">第 ${state.round} 局</span></div><p>牌墙耗尽，本局无人和牌。庄家连庄。</p>${seatHandsMarkup(state)}</div>`;
  }
  const result = state.result;
  const score = result.score || {};
  const payments = score.payments || [0, 0, 0, 0];
  const deltas = result.deltas || payments.map((n, p) => p === result.winner ? score.total || 0 : -n);
  const labels = score.labels?.length ? score.labels.join(' × ') : '和牌';
  const payerText = result.from === null || result.from === undefined ? '自摸，按规则逐家结算' : `${seatName(result.from)} 点炮`;
  const winner = Number(result.winner);
  const W = Number(score.W ?? score.w ?? 0);
  const settlement = settlementInfo(state, result, score, winner, W, payments);
  const rows = [0, 1, 2, 3].map((p) => {
    const pay = payments[p] || 0;
    const delta = deltas[p] || 0;
    if (p === winner) {
      const own = payerFactors(state, p);
      return `<div class="payment-row winner-row"><span class="payment-seat">${seatName(p)} · 胡</span><span>胡家收入 · 自身 ×${W}</span><strong>+${delta}</strong><em>本局累计 ${state.scores[p]} 分</em></div>`;
    }
    const row = settlement.rows[p];
    const formula = `${W} × ${row.L} = ${row.raw} 点`;
    const role = row.inScope ? (pay ? '本家付款' : '本家不付') : '本家不在范围';
    return `<div class="payment-row"><span class="payment-seat">${seatName(p)}</span><span>${role} · ${formula}</span><strong>${pay ? `-${pay}` : '0'}</strong><em>开口 ${row.open ? '×2' : '×1'} · 普通杠 ${row.normalKongs} · 皮杠 ${row.skinKongs} · 赖杠 ${row.jokerKongs}<br>${paymentReason(row, settlement)} · 变动 ${formatDelta(delta)}</em></div>`;
  }).join('');
  const factors = factorText(score.factors);
  const capLine = W >= settlement.cap ? `胡家倍数达到封顶线（×${settlement.cap}），只有未开口输家另付半顶。` : `胡家倍数 ×${W}，未达到封顶线 ×${settlement.cap}。`;
  return `<div class="result-card"><div class="result-heading"><span>${seatName(result.winner)} · ${labels}</span><span class="result-round">第 ${state.round} 局</span></div><p class="result-subtitle">${payerText} · 胡家自身 ×${W}${score.hard ? ' · 硬胡 ×2' : ''}</p><p class="factor-line"><b>倍数明细</b> ${factors}</p><p class="scope-line"><b>付款范围</b> ${settlement.scope} · 每家独立计算，低于 4 分不付款</p><p class="cap-line">${capLine}</p><div class="payments">${rows}</div>${seatHandsMarkup(state)}<p class="result-total">本局合计收入：<strong>${score.total ?? payments.reduce((a, b) => a + b, 0)}</strong></p></div>`;
}

function renderResult(state) {
  if (!resultRoot) return;
  if (!state.result) {
    shownResult = null;
    $('result-dialog').close();
    $('review-result').hidden = true;
    resultRoot.hidden = true;
    resultRoot.innerHTML = '';
    return;
  }
  resultRoot.hidden = false;
  resultRoot.innerHTML = resultMarkup(state);
  // 下一局按钮在牌桌上（renderActions），结算弹窗只留右上角的 ×
  $('review-result').hidden = false;
  const key = `${state.rules.seed}:${state.round}`;
  if (shownResult !== key) {
    shownResult = key;
    // 先亮一张"谁胡了、自摸还是点炮"的横幅，停一下再弹结算。
    // 之前一和牌就直接弹窗，整局的高潮快到看不清发生了什么。
    announceWin(state);
  }
}

// ---- 鸣牌提示 --------------------------------------------------------
// 别人吃碰杠时在对应座位上闪一下。不做成全局遮罩：那会打断节奏，
// 而这里要的只是让视线被带过去，知道桌上正在发生什么。
const CALL_FLASH = {
  chi: { text: '吃', cls: 'is-chi' },
  pong: { text: '碰', cls: 'is-pong' },
  kong: { text: '杠', cls: 'is-kong' },
};
let flashedLogCount = 0;
let flashTimer = null;
let audioLogCount = 0;

function callVoiceId(entry) {
  if (entry.type === 'chi' || entry.type === 'pong') return entry.type;
  // 牌桌上只喊「杠」和「赖子杠」：明杠、蓄杠、暗杠、皮杠一律喊「杠」
  if (entry.type === 'kong') return entry.kind === 'jokerKong' ? 'jokerKong' : 'kong';
  return null;
}
function winVoiceId(entry) {
  const labels = Array.isArray(entry.labels) ? entry.labels.map(String) : [];
  // 胡牌只喊三句：杠上开花喊「杠开」；其余自摸（含海底捞）喊「自摸」；胡别人的牌（含抢杠）喊「胡了」
  if (labels.includes('杠上开花')) return 'gangKai';
  return entry.from === null || entry.from === undefined || entry.from === entry.player ? 'selfDraw' : 'win';
}
function playAudioLogEntry(entry) {
  if (!entry) return;
  if (entry.type === 'discard') {
    audio.playTile();
    audio.playVoice(entry.player, `t${Math.floor(entry.tile / 4)}`, 1, 80);
  } else if (entry.type === 'chi' || entry.type === 'pong' || entry.type === 'kong') {
    audio.playTile();
    audio.playVoice(entry.player, callVoiceId(entry), 2);
  } else if (entry.type === 'win') {
    audio.playVoice(entry.player, winVoiceId(entry), 2);
  } else if (entry.type === 'draw') {
    audio.playVoice(0, 'draw', 2);
  }
}
function renderAudioEvents(state) {
  const log = state.log || [];
  if (log.length < audioLogCount) audioLogCount = 0;
  for (let i = audioLogCount; i < log.length; i += 1) playAudioLogEntry(log[i]);
  audioLogCount = log.length;
}

function resetCallFlash() {
  flashedLogCount = 0;
  if (flashTimer !== null) { window.clearTimeout(flashTimer); flashTimer = null; }
  const el = $('call-flash');
  if (el) { el.hidden = true; el.className = 'call-flash'; }
}

function renderCallFlash(state) {
  const el = $('call-flash');
  if (!el) return;
  const log = state.log || [];
  if (log.length < flashedLogCount) flashedLogCount = 0;   // 换局了
  if (log.length === flashedLogCount) return;

  // 只取这一批新条目里最后一次鸣牌，连续两次鸣牌时不排队、直接显示最新的
  let hit = null;
  for (let i = flashedLogCount; i < log.length; i += 1) {
    const e = log[i];
    const kind = String(e?.type || '').toLowerCase();
    if (CALL_FLASH[kind] && Number.isInteger(e.player)) hit = { ...CALL_FLASH[kind], player: e.player, entry: e };
  }
  flashedLogCount = log.length;
  if (!hit) return;

  const tile = hit.entry.tile !== undefined && hit.entry.tile !== null ? tileName(state, hit.entry.tile) : '';
  const kongKind = hit.entry.kind === 'skinKong' ? '皮杠'
    : hit.entry.kind === 'jokerKong' ? '赖杠'
    : hit.entry.kind === 'concealed' ? '暗杠'
    : hit.entry.kind === 'added' ? '蓄杠' : hit.text;
  el.innerHTML = `<b>${kongKind}</b>${tile ? `<span>${tile}</span>` : ''}`;
  el.className = `call-flash ${hit.cls} at-${hit.player}${hit.player === 0 ? ' is-me' : ''}`;
  el.hidden = false;
  // 重启动画：先移除再在下一帧加回
  el.classList.remove('is-on');
  requestAnimationFrame(() => el.classList.add('is-on'));
  if (flashTimer !== null) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    el.classList.remove('is-on');
    flashTimer = window.setTimeout(() => { el.hidden = true; flashTimer = null; }, 260);
  }, 1100);
}

// ---- 和牌横幅 --------------------------------------------------------
let winTimer = null;
let countTimer = null;

// 锦标赛模式（默认开）：每人按本金起（默认 300，可在工具栏改），任意一家低于 0 本场结束并排名。
// 关闭时和以前一样，分数从 0 起、一直打下去。开关只在开新的一场时生效，
// tournamentActive 记录的是"当前这一场"按哪种赛制开的。
const DEFAULT_START = 300;
const START_MIN = 10;
const START_MAX = 100000;
const TOURNAMENT_KEY = 'hz.tournament';
const START_KEY = 'hz.tournament.start';
let tournamentActive = false;
let matchStart = DEFAULT_START;   // 当前这一场的本金（排名里的盈亏按它算）
function sanitizeStart(v, fallback = DEFAULT_START) {
  const n = Math.round(Number(v));
  return String(v).trim() !== '' && Number.isFinite(n) && n >= START_MIN && n <= START_MAX ? n : fallback;
}
const startWanted = () => sanitizeStart(store.get(START_KEY, String(DEFAULT_START)));
const tournamentWanted = () => store.get(TOURNAMENT_KEY, '1') === '1';
const matchOver = (state) => tournamentActive && !!state?.result && state.scores.some((s) => s < 0);

/**
 * 庆祝分档：
 *   gold —— 金顶：三家付款的局面（自摸、七对、大胡）且胡家自身倍数达到封顶，
 *           未开口的付款者另付半顶。与 scoring.mjs 的 settle 同一条件。
 *   big  —— 大胡，或本局总收入 ≥ max(封顶, 30) 点
 *   normal
 */
const bigTotal = (cap) => Math.max(cap, 30);
function winTier(state) {
  const r = state.result;
  if (!r || r.type !== 'win') return 'normal';
  const cap = Number(r.cap ?? state.rules?.cap) || 50;
  const threePay = r.from === null || r.from === r.winner || !!r.score?.big || !!r.score?.sevenPairs;
  if (threePay && (r.score?.W || 0) >= cap) return 'gold';
  if (r.score?.big || (r.score?.total || 0) >= bigTotal(cap)) return 'big';
  return 'normal';
}

function closeWinBanner(openResult = true) {
  const banner = $('win-banner');
  if (!banner || banner.hidden) return;
  if (winTimer !== null) { window.clearTimeout(winTimer); winTimer = null; }
  if (countTimer !== null) { window.clearInterval(countTimer); countTimer = null; }
  banner.hidden = true;
  banner.classList.remove('is-in');
  $('win-confetti').innerHTML = '';
  if (!openResult || !game?.result) return;
  // 有人跌破 0：直接弹本场排名（排名里可以再看本局结算）
  if (matchOver(game)) { showRanking(); return; }
  if (!$('result-dialog').open) $('result-dialog').showModal();
}

/** 彩带：纯 CSS 动画的小方块，数量随档位增加；减少动画偏好下不放 */
function launchConfetti(tier) {
  const box = $('win-confetti');
  box.innerHTML = '';
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const n = tier === 'gold' ? 90 : 54;
  const colors = tier === 'gold'
    ? ['#f5d77a', '#e8b93c', '#fff4c2', '#c8902a', '#fbe7a1', '#d9a441']
    : ['#e0574a', '#f2c14e', '#3f9b6e', '#4d8fd6', '#f6f1e3', '#c85a8f'];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i += 1) {
    const s = document.createElement('i');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.9}s`;
    s.style.animationDuration = `${2.2 + Math.random() * 1.8}s`;
    s.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    s.style.setProperty('--spin', `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540)}deg`);
    if (Math.random() < 0.35) s.classList.add('is-strip');
    frag.appendChild(s);
  }
  box.appendChild(frag);
}

/** 总分从 0 滚到终值 */
function countUp(el, to, ms = 900) {
  if (countTimer !== null) window.clearInterval(countTimer);
  const t0 = performance.now();
  el.textContent = '+0';
  countTimer = window.setInterval(() => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.textContent = `+${Math.round(to * (1 - (1 - k) ** 3))}`;
    if (k >= 1) { window.clearInterval(countTimer); countTimer = null; }
  }, 30);
}

function announceWin(state) {
  const banner = $('win-banner');
  const r = state.result;
  if (!banner || !r) { $('result-dialog').showModal(); return; }

  const draw = r.type === 'draw';
  const selfDraw = !draw && r.from === null;
  const isMe = !draw && r.winner === 0;
  const winner = draw ? '' : seatName(r.winner);

  const tier = draw ? 'normal' : winTier(state);
  banner.className = `win-banner ${draw ? 'is-draw' : selfDraw ? 'is-selfdraw' : 'is-ron'}${isMe ? ' is-me' : ''} tier-${tier}`;
  $('win-kind').textContent = tier === 'gold' ? '金 顶' : draw ? '荒 庄' : selfDraw ? '自 摸' : '点 炮';
  // 高档位：顶部小标签 + 总分滚动
  const cap = Number(r?.cap ?? state.rules?.cap) || 50;
  $('win-eyebrow').textContent = tier === 'gold'
    ? `胡家倍数 ×${r.score.W} · 达到 ${cap} 封顶`
    : tier === 'big' && r.score?.big ? '大 胡' : '';
  const totalEl = $('win-total');
  totalEl.hidden = tier === 'normal';
  if (tier !== 'normal') countUp(totalEl, r.score?.total || 0, tier === 'gold' ? 1400 : 1000);
  $('win-who').textContent = draw
    ? '牌墙摸完，无人和牌'
    : selfDraw
      ? `${winner}${isMe ? '（你）' : ''} 自摸`
      : `${winner}${isMe ? '（你）' : ''} 和牌 · ${seatName(r.from)} 点炮`;
  // 点炮时和的是别人打出的那张（result.tile）；自摸时 result.tile 是空的，
  // 和的就是刚摸进来的那张，用 lastDraw 补上，否则自摸横幅看不到牌。
  const winTile = !draw
    ? (r.tile ?? (selfDraw && state.lastDrawPlayer === r.winner ? state.lastDraw : null))
    : null;
  $('win-tile').innerHTML = (winTile !== null && winTile !== undefined)
    ? tileMarkup(state, winTile) : '';
  const labels = draw ? [] : (r.score?.labels || []);
  $('win-labels').innerHTML = tier === 'normal'
    ? labels.join(' · ')
    : labels.map((l) => `<b>${l}</b>`).join('');
  // 金顶时标出谁多付了顶外半顶
  $('win-deltas').innerHTML = draw ? '' : [0, 1, 2, 3]
    .map((p) => {
      const extra = tier === 'gold' && p !== r.winner && (r.score?.payments?.[p] || 0) > cap
        ? `<em>含顶外 +${r.score.payments[p] - cap}</em>` : '';
      return `<span class="${r.deltas[p] > 0 ? 'up' : r.deltas[p] < 0 ? 'down' : ''}">${seatName(p)} ${formatDelta(r.deltas[p])}${extra}</span>`;
    })
    .join('');

  banner.hidden = false;
  if (tier !== 'normal') launchConfetti(tier);
  // 先撤 hidden 再加动画类，否则过渡不会触发
  requestAnimationFrame(() => banner.classList.add('is-in'));
  // 三档横幅都不自动消失，玩家点一下才关
}

// ---- 本场排名 --------------------------------------------------------
function showRanking() {
  const dlg = $('match-dialog');
  if (!dlg || !game) return;
  const scores = game.scores;
  const order = [0, 1, 2, 3].sort((a, b) => scores[b] - scores[a] || a - b);
  const busted = [0, 1, 2, 3].filter((p) => scores[p] < 0).map((p) => seatName(p));
  let rank = 0;
  const rows = order.map((p, i) => {
    if (i === 0 || scores[p] !== scores[order[i - 1]]) rank = i + 1;   // 同分同名次
    const delta = scores[p] - matchStart;
    return `<li class="rank-${rank}${p === 0 ? ' is-me' : ''}${scores[p] < 0 ? ' is-busted' : ''}">
      <span class="rank-no">${rank}</span>
      <span class="rank-who">${seatName(p)}${p === 0 ? '（你）' : ''}${scores[p] < 0 ? '<small>跌破 0 分</small>' : ''}</span>
      <span class="rank-score">${scores[p]}<small>${formatDelta(delta)}</small></span>
    </li>`;
  }).join('');
  $('match-sub').textContent = `共 ${game.round} 局 · ${busted.join('、')} 跌破 0 分，本场结束`;
  $('match-rows').innerHTML = rows;
  const me = order.indexOf(0);
  const myRank = [...$('match-rows').children][me]?.querySelector('.rank-no')?.textContent;
  $('match-title').textContent = myRank === '1' ? '你是本场第一！' : `本场结束 · 你排第 ${myRank}`;
  if ($('result-dialog').open) $('result-dialog').close();
  dlg.showModal();
  if (myRank === '1') launchRankConfetti();
}

function launchRankConfetti() {
  const box = $('match-confetti');
  if (!box) return;
  box.innerHTML = '';
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const colors = ['#f5d77a', '#e0574a', '#3f9b6e', '#4d8fd6', '#fff4c2'];
  for (let i = 0; i < 60; i += 1) {
    const s = document.createElement('i');
    s.style.left = `${Math.random() * 100}%`;
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = `${Math.random() * 0.8}s`;
    s.style.animationDuration = `${2.4 + Math.random() * 1.6}s`;
    s.style.setProperty('--drift', `${(Math.random() - 0.5) * 140}px`);
    s.style.setProperty('--spin', `${(Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 540)}deg`);
    box.appendChild(s);
  }
}

function logTileName(entry, state) {
  if (entry.tileName) return String(entry.tileName);
  let value = entry.tile;
  if (value && typeof value === 'object') {
    if (value.name) return String(value.name);
    if (value.type !== undefined) return nameOfType(Number(value.type));
    value = value.id ?? value.tile;
  }
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' && Number.isNaN(Number(value))) return value;
  const explicitType = entry.tileType ?? entry.typeId ?? entry.tileKind;
  const type = explicitType === undefined ? typeOf(Number(value)) : Number(explicitType);
  return nameOfType(type);
}

function formatLogEntry(entry, state) {
  if (entry === undefined || entry === null) return '';
  if (typeof entry === 'string' || typeof entry === 'number') return String(entry);
  if (typeof entry !== 'object') return String(entry);
  const type = String(entry.type ?? entry.event ?? entry.kind ?? '').toLowerCase();
  const player = Number.isInteger(entry.player) ? seatName(entry.player) : '';
  const tile = logTileName(entry, state);
  const from = Number.isInteger(entry.from) ? seatName(entry.from) : '';
  const labels = Array.isArray(entry.labels) ? entry.labels.join('、') : entry.labels ? String(entry.labels) : '';
  const consume = Array.isArray(entry.tiles) ? entry.tiles.map((value) => {
    if (typeof value === 'string') return value;
    return nameOfType(Number(value) >= 34 ? typeOf(Number(value)) : typeOf(Number(value)));
  }).join('、') : '';
  const kindNames = { skin: '皮杠', joker: '赖杠', skinKong: '皮杠', jokerKong: '赖杠', concealed: '暗杠', concealedKong: '暗杠', added: '蓄杠', addedKong: '蓄杠', exposed: '明杠', exposedKong: '明杠', kong: '杠' };
  if (entry.message || entry.text) return `${player}${entry.message ?? entry.text}`;
  if (type === 'discard') return `${player}打出 ${tile}`;
  if (type === 'draw' && !player && !tile) return '荒庄';
  if (type === 'draw' || type === 'deal') return `${player}${type === 'deal' ? '起手' : '摸到'}${tile ? ` ${tile}` : ''}`;
  if (type === 'chi') return `${player}吃 ${tile}${consume ? `（${consume}）` : ''}${from ? ` · 来自${from}` : ''}`;
  if (type === 'pong' || type === 'peng') return `${player}碰 ${tile}${from ? ` · 来自${from}` : ''}`;
  if (type === 'kongpending') return `${player}等待抢杠${tile ? ` ${tile}` : ''}`;
  if (type === 'kong' || type.includes('kong')) return `${player}${kindNames[entry.kind] || kindNames[type] || '杠'}${tile ? ` ${tile}` : ''}`;
  if (type === 'win' || type === 'hu' || type === 'selfdraw') return `${player}和牌${tile ? ` ${tile}` : ''}${labels ? ` · ${labels}` : ''}${from ? `（${from}点炮）` : ''}`;
  if (type === 'pass') return `${player}过`;
  if (type === 'drawgame' || type === 'exhaust' || type === '荒庄') return '荒庄';
  if (type === 'start' || type === 'round') return `第 ${entry.round ?? state.round} 局开始`;
  const fallback = [player, entry.type ?? entry.kind, tile, labels].filter(Boolean).join(' ');
  return fallback || '牌局进行中';
}

// 整局动态全部留着，容器只有三行高，其余用鼠标滚动回看。
// 只在条目数变化时重建 DOM——render() 每步都会跑，整局几百条不该每次重排。
let renderedLogCount = -1;

function renderLog(state) {
  const errRoot = $('log-error');
  if (errRoot) {
    errRoot.hidden = !lastError;
    errRoot.textContent = lastError ? `提示：${lastError}` : '';
  }
  if (!logRoot) return;

  const entries = state.log || [];
  if (entries.length === renderedLogCount) return;

  // 用户滚上去翻记录时不要把他拽回底部
  const atBottom = logRoot.scrollHeight - logRoot.scrollTop - logRoot.clientHeight < 24;
  const first = renderedLogCount < 0;

  if (!entries.length) {
    logRoot.innerHTML = '<li class="log-empty">四席就位，等待你的第一手。</li>';
  } else {
    const rows = [];
    for (let i = 0; i < entries.length; i += 1) {
      const text = formatLogEntry(entries[i], state);
      if (!text) continue;
      rows.push(`<li${i === entries.length - 1 ? ' class="is-latest"' : ''}>${text}</li>`);
    }
    logRoot.innerHTML = rows.join('') || '<li class="log-empty">牌局进行中</li>';
  }
  renderedLogCount = entries.length;
  if (first || atBottom) logRoot.scrollTop = logRoot.scrollHeight;
}

function render() {
  if (!game) return;
  const state = visibleState(game, 0);
  const actions = state.phase === 'done' ? [] : playerActions(state);
  if (selectedTile !== null && !actions.some((a) => a.kind === 'discard' && a.tile === selectedTile)) selectedTile = null;
  renderCenter(state);
  for (let p = 0; p < 4; p += 1) renderSeat(state, p);
  renderHand(state, actions);
  if (meldRoot) meldRoot.innerHTML = meldMarkup(state, 0);
  renderActions(state, actions);
  renderCallFlash(state);
  renderAudioEvents(state);
  renderAdvice(state);
  renderResult(state);
  renderLog(state);
  document.body.dataset.phase = state.phase;
  document.body.dataset.turn = String(state.turn);
  document.body.dataset.pendingSeat = String(pendingSeat(state) ?? '');
}

function perform(action) {
  if (!action || !game || game.phase === 'done') return;
  try {
    game = applyAction(game, action);
    selectedTile = null;
    lastError = '';
    try { validateState(game); } catch (error) { lastError = `状态校验：${error.message}`; }
    render();
    continueGame();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    render();
  }
}

function continueGame() {
  if (!game || game.phase === 'done') return;
  const state = visibleState(game, 0);
  const p = pendingSeat(state);
  if (p !== null) {
    if (p === 0 && !autoplay) {
      const actions = playerActions(state);
      const actionable = actions.filter((a) => a.kind !== 'pass');
      if (actionable.length) return;
      const pass = actions.find((a) => a.kind === 'pass');
      if (pass) schedule(() => perform(pass), 200);
      return;
    }
    const chosen = aiPolicy(p)(game, p);
    if (chosen) schedule(() => perform(chosen), pacedDelay(chosen));
    return;
  }
  if (state.pending) return;
  if (game.turn === 0 && !autoplay) return;
  const turn = game.turn;
  const chosen = aiPolicy(turn)(game, turn);
  if (chosen) schedule(() => perform(chosen), pacedDelay(chosen));
}

function restart() {
  resetCallFlash();
  closeWinBanner(false);
  generation += 1;
  clearTimer();
  selectedTile = null;
  lastError = '';
  renderedLogCount = -1;
  resetCoach();
  tournamentActive = tournamentWanted();
  matchStart = startWanted();
  const start = tournamentActive ? matchStart : 0;
  game = createGame({ cap: Number(capRoot?.value || 50), seed: seedFromUrl ?? Date.now(), dealer: 0, scores: [start, start, start, start], round: 1 });
  const badge = $('tournament-badge');
  if (badge) { badge.hidden = !tournamentActive; badge.textContent = `锦标赛 · ${matchStart} 点起`; }
  audioLogCount = game.log?.length || 0;
  audio.playShuffle();
  render();
  continueGame();
}

function next() {
  resetCallFlash();
  closeWinBanner(false);
  if (!game?.result) return;
  // 有人跌破 0 分：本场已结束，不再开下一局
  if (matchOver(game)) { showRanking(); return; }
  generation += 1;
  clearTimer();
  selectedTile = null;
  lastError = '';
  renderedLogCount = -1;
  resetCoach();
  game = nextRound(game);
  audioLogCount = game.log?.length || 0;
  audio.playShuffle();
  render();
  continueGame();
}

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const kind = target.dataset.action;
  if (kind === 'next-round') { next(); return; }   // next() 在本场已结束时会改为弹出排名
  if (kind === 'open-result') {
    if (matchOver(game)) showRanking();
    else if (!$('result-dialog').open) $('result-dialog').showModal();
    return;
  }
  if (kind === 'select-tile') {
    const id = Number(target.dataset.tileId);
    const state = visibleState(game, 0);
    const action = actionForTile(playerActions(state), id);
    if (!action) return;
    selectedTile = selectedTile === id ? null : id;
    render();
    return;
  }
  if (kind === 'commit-discard') {
    const action = actionForTile(playerActions(visibleState(game, 0)), selectedTile);
    if (action) perform(action);
    return;
  }
  if (kind === 'game-action') {
    const state = visibleState(game, 0);
    const actions = playerActions(state);
    const actionIndex = Number(target.dataset.actionIndex);
    const indexed = Number.isInteger(actionIndex) && actionIndex >= 0 ? actions[actionIndex] : null;
    const tile = target.dataset.tileId === '' ? undefined : Number(target.dataset.tileId);
    const meldIndex = target.dataset.meldIndex === '' ? undefined : Number(target.dataset.meldIndex);
    const action = indexed || actions.find((a) => a.kind === target.dataset.kind && (tile === undefined || a.tile === tile) && (meldIndex === undefined || a.meldIndex === meldIndex));
    if (action) perform(action);
  }
}

$('win-banner')?.addEventListener('click', () => closeWinBanner(true));
document.addEventListener('click', onClick);
$('restart')?.addEventListener('click', () => confirmRestart());

// ---- 二次确认 ----
const confirmDialog = $('confirm-dialog');
/** 弹出确认框，确定返回 true；取消、Esc、点框外都算 false。
 *  结果在按钮点击时直接给出，不等 dialog 的 close 事件——页面不可见时浏览器会推迟那个事件。 */
let confirmResolve = null;
function settleConfirm(value) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (confirmDialog?.open) confirmDialog.close();
  resolve?.(value);
}
function askConfirm({ title, message, ok = '确定' }) {
  if (!confirmDialog) return Promise.resolve(true);
  settleConfirm(false);   // 上一个还没答的按取消处理
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = message;
    $('confirm-ok').textContent = ok;
    confirmResolve = resolve;
    confirmDialog.showModal();
  });
}
$('confirm-ok')?.addEventListener('click', () => settleConfirm(true));
$('confirm-cancel')?.addEventListener('click', () => settleConfirm(false));
confirmDialog?.addEventListener('click', (event) => { if (event.target === confirmDialog) settleConfirm(false); });
confirmDialog?.addEventListener('close', () => settleConfirm(false));   // Esc
/** 锦标赛这一场已经开打、还没分出结果 */
function matchInProgress() {
  if (!tournamentActive || !game || matchOver(game)) return false;
  const fresh = game.round === 1 && !game.result && game.discards.every((d) => d.length === 0);
  return !fresh;
}
/** 放弃本场前的确认：锦标赛进行中才问，否则直接放行。newStart 是重开后的本金。 */
async function confirmAbandon(newStart = startWanted()) {
  if (!matchInProgress()) return true;
  return askConfirm({
    title: '放弃本场锦标赛？',
    message: `本场还没结束（第 ${game.round} 局，你现在 ${game.scores[0]} 分）。重新开始会放弃这一场，四家都按 ${newStart} 点重新开局。`,
    ok: '放弃本场，重新开始',
  });
}
async function confirmRestart() {
  if (await confirmAbandon()) restart();
}

// ---- 锦标赛开关 ----
const tourToggle = $('tournament-toggle');
let tourHintTimer = null;
function showTourHint(html, stay = 6000) {
  const el = $('tour-hint');
  if (!el) return;
  el.innerHTML = html;
  el.hidden = false;
  if (tourHintTimer) window.clearTimeout(tourHintTimer);
  tourHintTimer = window.setTimeout(() => { el.hidden = true; }, stay);
}
// 这一场刚开、还没人出过牌就直接按新设置开局；打到一半则不打断，下一场生效
function applyTourChange(explain) {
  const fresh = game && game.round === 1 && !game.result && game.discards.every((d) => d.length === 0);
  if (fresh) { restart(); showTourHint(`${explain} 已按新设置开局。`); return; }
  showTourHint(`${explain} 从下一场开始生效。<button type="button" data-tour-now>现在就开新的一场</button>`, 9000);
}
const tourPoints = $('tour-points');
const tourPointsWrap = $('tour-points-wrap');
if (tourToggle) {
  tourToggle.checked = tournamentWanted();
  if (tourPointsWrap) tourPointsWrap.hidden = !tourToggle.checked;
  tourToggle.addEventListener('change', () => {
    store.set(TOURNAMENT_KEY, tourToggle.checked ? '1' : '0');
    if (tourPointsWrap) tourPointsWrap.hidden = !tourToggle.checked;
    applyTourChange(tourToggle.checked
      ? `<b>锦标赛模式</b>：每人 ${startWanted()} 点起，任一家跌破 0 分本场结束，弹出排名。`
      : '<b>锦标赛模式已关</b>：分数从 0 起，一直打下去，不排名。');
  });
}
if (tourPoints) {
  tourPoints.value = String(startWanted());
  tourPoints.addEventListener('change', () => {
    // 输错（空、非数字、超出 10–100000）就退回原来的值，什么都不改
    const old = startWanted();
    const v = sanitizeStart(tourPoints.value, old);
    tourPoints.value = String(v);
    if (v === old) return;
    if (!tourToggle?.checked) { store.set(START_KEY, String(v)); return; }
    // 改本金就开新的一场；本场还在打时先确认，取消则退回原值
    confirmAbandon(v).then((ok) => {
      if (!ok) { tourPoints.value = String(old); return; }
      store.set(START_KEY, String(v));
      restart();
      showTourHint(`<b>锦标赛本金</b>：每人 ${v} 点起，已开新的一场。`);
    });
  });
}
$('tour-hint')?.addEventListener('click', (event) => {
  if (!event.target.closest('[data-tour-now]')) return;
  $('tour-hint').hidden = true;
  confirmRestart();
});
// 封顶热更新：当前这一局立即按新封顶计分，之后的局沿用（nextRound 会带上 rules.cap）
capRoot?.addEventListener('change', () => {
  if (!game) return;
  game.rules.cap = Number(capRoot.value || 50);
  generation += 1;
  clearTimer();
  render();
  continueGame();
});
// ---- 建议开关的四位数密码 ----
// 静态网页防不住懂前端的人（改一行代码就能绕过），这只是"防君子"：
// 源码里只存加盐哈希、看不到明文；输对一次后本标签页内记住，刷新或关掉标签页要重输。
const ADVICE_PIN_HASH = 'c3c82fce';
const ADVICE_PIN_SALT = 'hz-advice-pin:v1:';
const ADVICE_UNLOCK_KEY = 'hz.advice.unlocked';
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
const adviceUnlocked = () => { try { return sessionStorage.getItem(ADVICE_UNLOCK_KEY) === '1'; } catch { return false; } };
const pinDialog = $('pin-dialog');
function openPinDialog() {
  const input = $('pin-input');
  input.value = '';
  $('pin-msg').textContent = '';
  pinDialog.showModal();
  input.focus();
}
function submitPin() {
  const input = $('pin-input');
  const card = pinDialog.querySelector('.pin-card');
  if (!/^\d{4}$/.test(input.value)) { $('pin-msg').textContent = '请输入 4 位数字'; return; }
  if (fnv1a(ADVICE_PIN_SALT + input.value) !== ADVICE_PIN_HASH) {
    $('pin-msg').textContent = '密码不对';
    input.value = '';
    card.classList.remove('is-wrong'); void card.offsetWidth; card.classList.add('is-wrong');
    return;
  }
  try { sessionStorage.setItem(ADVICE_UNLOCK_KEY, '1'); } catch { /* 隐私模式下只在本次有效 */ }
  pinDialog.close();
  adviceToggle.checked = true;
  render();
}
adviceToggle?.addEventListener('change', () => {
  if (adviceToggle.checked && !adviceUnlocked()) { adviceToggle.checked = false; openPinDialog(); return; }
  render();
});
$('pin-form')?.addEventListener('submit', (event) => { event.preventDefault(); submitPin(); });
$('pin-cancel')?.addEventListener('click', () => pinDialog.close());
// 输满 4 位自动提交
$('pin-input')?.addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
  if (event.target.value.length === 4) submitPin();
});
llmToggle?.addEventListener('change', async () => {
  store.set(LLM_KEYS.enabled, llmToggle.checked ? '1' : '0');
  await enableLlm();
});
$('llm-settings')?.addEventListener('click', async () => { renderLlmProvider(); if (llmToggle?.checked && !proxyProviders) proxyProviders = await probeProxy(); renderLlmProvider(); llmDialog.showModal(); });
$('llm-close')?.addEventListener('click', () => llmDialog.close());
$('llm-done')?.addEventListener('click', () => {
  store.set(LLM_KEYS.provider, $('llm-provider').value);
  store.set(LLM_KEYS.model, $('llm-model').value.trim());
  store.set(LLM_KEYS.key, $('llm-key').value);
  store.set(LLM_KEYS.baseUrl, $('llm-base').value.trim());
  store.set(LLM_KEYS.viaProxy, $('llm-proxy').checked && !!proxyProviders ? '1' : '0');
  llmDialog.close();
});
$('llm-clear-key')?.addEventListener('click', () => { store.del(LLM_KEYS.key); $('llm-key').value = ''; });
$('llm-provider')?.addEventListener('change', () => {
  const p = providerOf($('llm-provider').value);
  $('llm-model').value = p.models[0] || '';
  $('llm-key-url').hidden = !p.keyUrl;
  $('llm-key-url').href = p.keyUrl || '#';
  renderLlmPreview();
  setTestResult('');
});
for (const id of ['llm-model', 'llm-base', 'llm-proxy']) $(id)?.addEventListener('input', renderLlmPreview);
$('llm-test')?.addEventListener('click', runConnectionTest);
llmDialog?.addEventListener('close', () => testController?.abort());
askSend?.addEventListener('click', sendQuestion);
askCancel?.addEventListener('click', () => askController?.abort());
askInput?.addEventListener('keydown', (event) => {
  // 中文输入法选词时的回车也会触发 keydown，不拦掉会半句话就发出去
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendQuestion(); }
});
// 换对手策略不重开牌局：作废已排队的那一步，让新策略立刻接手。
// ---- 每家对手的打法 ----------------------------------------------------
function renderAiSeats() {
  const box = $('ai-seats');
  if (box) {
    box.innerHTML = AI_SEATS.map((p) => {
      const cur = aiNameOf(p);
      const who = SEATS[p].name;
      const opts = Object.entries(AI_POLICIES)
        .map(([id, m]) => `<option value="${id}"${id === cur ? ' selected' : ''}>${m.label}</option>`).join('');
      return `<label class="ai-seat-row"><span class="ai-seat-name">${who}</span>`
        + `<select data-ai-seat="${p}" aria-label="${who} 的难度">${opts}</select></label>`;
    }).join('');
  }
  const summary = $('ai-summary');
  // 工具栏上只摘要三家对手，不含托管那一档
  if (summary) summary.textContent = [1, 2, 3].map((p) => AI_POLICIES[aiNameOf(p)].label).join('·');
}

$('ai-config')?.addEventListener('click', () => { renderAiSeats(); $('ai-dialog').showModal(); });
$('ai-close')?.addEventListener('click', () => $('ai-dialog').close());
$('ai-done')?.addEventListener('click', () => $('ai-dialog').close());

function renderSoundSettings() {
  $('sound-voice').checked = audio.settings.voice;
  $('sound-sfx').checked = audio.settings.sfx;
  $('sound-ambience').checked = audio.settings.ambience;
  $('sound-volume').value = audio.settings.volume;
  $('sound-volume-value').textContent = `${Math.round(audio.settings.volume * 100)}%`;
}
function saveSoundSetting(key, value) {
  store.set(AUDIO_KEYS[key], String(value));
  audio.configure({ [key]: key === 'volume' ? Number(value) : !!value });
}
$('sound-config')?.addEventListener('click', () => { renderSoundSettings(); soundDialog.showModal(); });
$('sound-close')?.addEventListener('click', () => soundDialog.close());
$('sound-voice')?.addEventListener('change', event => saveSoundSetting('voice', event.target.checked));
$('sound-sfx')?.addEventListener('change', event => saveSoundSetting('sfx', event.target.checked));
$('sound-ambience')?.addEventListener('change', event => saveSoundSetting('ambience', event.target.checked));
$('sound-volume')?.addEventListener('input', event => { saveSoundSetting('volume', event.target.value); $('sound-volume-value').textContent = `${Math.round(Number(event.target.value) * 100)}%`; });
document.querySelectorAll('[data-preview-seat]').forEach(button => button.addEventListener('click', () => {
  const seat = Number(button.dataset.previewSeat);
  audio.playVoice(seat, 'pong', 2);
  // 等「碰！」念完再接牌名：固定延时会在「碰！」较长的嗓音上撞进叫牌优先规则，牌名被跳过
  const wait = audio.voiceRemainingMs();
  window.setTimeout(() => audio.playVoice(seat, 't2', 1), (wait || 600) + 120);
}));
// 换打法后作废已排队的那一步，让新打法立刻接手
function aiChanged() {
  const summary = $('ai-summary');
  if (summary) summary.textContent = [1, 2, 3].map((p) => AI_POLICIES[aiNameOf(p)].label).join('·');
  generation += 1;
  clearTimer();
  render();
  continueGame();
}
$('ai-seats')?.addEventListener('change', (event) => {
  const sel = event.target.closest('[data-ai-seat]');
  if (!sel) return;
  store.set(AI_SEAT_KEY(Number(sel.dataset.aiSeat)), sel.value);
  aiChanged();
});
// 一键把三家设成同一档
$('ai-presets')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-ai-all]');
  if (!btn) return;
  for (const p of AI_SEATS) store.set(AI_SEAT_KEY(p), btn.dataset.aiAll);
  renderAiSeats();
  aiChanged();
});

rulesRoot?.addEventListener('click', () => drawerRoot.showModal());
closeRulesRoot?.addEventListener('click', () => drawerRoot.close());
$('closeResult').addEventListener('click', () => $('result-dialog').close());
$('review-result').addEventListener('click', () => (matchOver(game) ? showRanking() : $('result-dialog').showModal()));
$('match-again')?.addEventListener('click', () => { $('match-dialog').close(); restart(); });
$('match-result')?.addEventListener('click', () => { $('match-dialog').close(); $('result-dialog').showModal(); });
for (const dialog of [drawerRoot, $('result-dialog'), llmDialog, soundDialog]) {
  if (!dialog) continue;
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
document.addEventListener('keydown', event => {
  if (drawerRoot.open || $('result-dialog').open || $('ai-dialog')?.open || llmDialog.open || soundDialog?.open || $('match-dialog')?.open || $('pin-dialog')?.open || $('confirm-dialog')?.open || event.target.closest('input,textarea,select')) return;
  if (event.key === 'Escape') { selectedTile = null; render(); }
  if (event.key === 'Enter' && selectedTile !== null && !event.target.closest('input,select,button:not(.tile-button)')) {
    event.preventDefault();
    const action = actionForTile(playerActions(visibleState(game, 0)), selectedTile);
    if (action) perform(action);
  }
});
autoRoot?.addEventListener('change', () => {
  autoplay = !!autoRoot.checked;
  generation += 1;
  clearTimer();
  render();
  continueGame();
});

renderAiSeats();
llmToggle.checked = store.get(LLM_KEYS.enabled, '0') === '1';
if (llmToggle.checked) enableLlm();
restart();

// 调试入口：只在地址带 ?debug 时暴露，用来直接预览庆祝横幅与本场排名，正常游戏不受影响
if (new URLSearchParams(location.search).has('debug')) {
  window.__hzDebug = {
    get game() { return game; },
    set game(g) { game = g; render(); },
    announceWin, showRanking, winTier, matchOver,
  };
}

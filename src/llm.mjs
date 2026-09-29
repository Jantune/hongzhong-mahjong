// 多家大模型的浏览器直连适配层。零依赖、只用 fetch。
//
// 五种线上协议都实测过 CORS 预检（Origin: null，即 file:// 打开时浏览器发送的值）：
//   Anthropic Messages      allow-origin: *
//   OpenAI Chat Completions allow-origin: null
//   OpenAI Responses        allow-origin: *
//   Gemini generateContent  allow-origin: null
//   xAI Grok                allow-origin: *
// 所以双击打开的单文件 HTML 也能直接用，不需要起服务器。
//
// 每家都带官方默认地址，同时都允许改 baseUrl——走代理、走网关、走自建中转
// （包括国内可达的镜像）都只要换这一个字段，协议形状不变。
//
// 刻意不发 temperature / max_tokens（除 Anthropic 必填外）：各家对这些字段的
// 名称和取值约束差别很大（max_tokens / max_completion_tokens / max_output_tokens /
// maxOutputTokens），推理模型还会直接拒收，省掉它们反而最稳。

const JSON_HEADERS = { 'content-type': 'application/json' };

const trimBase = (s) => String(s || '').trim().replace(/\/+$/, '');

// OpenAI 的鉴权失败响应不带 Access-Control-Allow-Origin（实测：不带 Authorization
// 头时 401 会返回 *，带了一个无效 key 反而没有），浏览器于是把它吞成一个笼统的
// TypeError。这条提示是为了让用户不至于以为是网络问题。
const OPENAI_NET_HINT = '注意：OpenAI 在密钥无效时不返回 CORS 头，浏览器只能报"连接失败"，所以这条错误很可能其实是密钥不对。';

/** OpenAI 兼容的 chat/completions 形状：OpenAI、Grok、以及绝大多数第三方网关。 */
const chatShape = {
  endpoint: (base) => `${base}/chat/completions`,
  headers: (key) => ({ ...JSON_HEADERS, authorization: `Bearer ${key}` }),
  body: ({ model, system, messages }) => ({
    model,
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  }),
  extract: (j) => (j?.choices?.[0]?.message?.content || '').trim(),
  // OpenAI 是 {error:{message}}，xAI 是 {code, error:"字符串"}，两种都要认
  error: (j) => (typeof j?.error === 'string' ? j.error : j?.error?.message || j?.message),
};

export const PROVIDERS = {
  claude: {
    label: 'Claude · Messages',
    vendor: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    versionPath: '/v1',
    baseExample: 'https://你的中转.com（自动补 /v1）',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    endpoint: (base) => `${base}/messages`,
    headers: (key) => ({
      ...JSON_HEADERS,
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // 没有这个头，浏览器直连会被 Anthropic 拒绝
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    body: ({ model, system, messages }) => ({
      model,
      max_tokens: 1024,                    // Anthropic 这个字段是必填
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    extract: (j) => (j?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    error: (j) => j?.error?.message,
  },

  openai: {
    label: 'OpenAI · Chat Completions',
    vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    netHint: OPENAI_NET_HINT,
    ...chatShape,
  },

  'openai-responses': {
    label: 'OpenAI · Responses',
    vendor: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    netHint: OPENAI_NET_HINT,
    endpoint: (base) => `${base}/responses`,
    headers: (key) => ({ ...JSON_HEADERS, authorization: `Bearer ${key}` }),
    body: ({ model, system, messages }) => ({
      model,
      instructions: system,                // Responses 用 instructions 承载系统提示
      input: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    extract: (j) => {
      if (typeof j?.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
      const parts = [];
      for (const item of j?.output || []) {
        for (const c of item?.content || []) if (typeof c?.text === 'string') parts.push(c.text);
      }
      return parts.join('').trim();
    },
    error: (j) => j?.error?.message,
  },

  gemini: {
    label: 'Gemini · generateContent',
    vendor: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    versionPath: '/v1beta',
    baseExample: 'https://你的中转.com（自动补 /v1beta）',
    models: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.1-pro-preview'],
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    endpoint: (base, model) => `${base}/models/${encodeURIComponent(model)}:generateContent`,
    headers: (key) => ({ ...JSON_HEADERS, 'x-goog-api-key': key }),
    body: ({ system, messages }) => ({
      systemInstruction: { parts: [{ text: system }] },
      // Gemini 的助手角色叫 model，不是 assistant
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }),
    extract: (j) => (j?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim(),
    error: (j) => j?.error?.message ||
      (j?.promptFeedback?.blockReason ? `被安全策略拦截：${j.promptFeedback.blockReason}` : ''),
  },

  grok: {
    label: 'Grok · xAI',
    vendor: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    versionPath: '/v1',
    baseExample: 'https://你的中转.com（自动补 /v1）',
    models: ['grok-4.7', 'grok-4.6', 'grok-4.5'],
    keyHint: 'xai-...',
    keyUrl: 'https://console.x.ai/',
    ...chatShape,
  },

  custom: {
    label: '自定义（OpenAI 兼容）',
    vendor: '自定义服务',
    baseUrl: '',                           // 没有默认，必须自己填
    versionPath: '/v1',
    // 国内几家的 OpenAI 兼容地址写法各不相同，示例挑最常见的两种：只填域名、带路径
    baseExample: 'https://api.deepseek.com 或 https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [],
    keyHint: '该服务的密钥',
    keyUrl: '',
    ...chatShape,
  },
};

export const DEFAULT_PROVIDER = 'claude';

export function providerOf(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

// 用户填接口地址的写法五花八门：只填域名、带不带 /v1、把完整接口地址整条贴进来、
// 漏了 https://、末尾多个斜杠。这里统一规整成"版本路径为止"的 base，再由各家的
// endpoint() 拼出完整地址。
const ENDPOINT_TAILS = [
  /\/chat\/completions$/i,
  /\/messages$/i,
  /\/responses$/i,
  /\/models\/[^/]+:(stream)?generateContent$/i,
  /\/models$/i,
];

/**
 * 规整用户填的接口地址：
 * - 没写协议：本机地址补 http://，其余补 https://
 * - 末尾是具体接口（/chat/completions、/messages 等）：去掉，只保留 base
 * - 只有域名、没有路径：补上该协议的默认版本路径（多数是 /v1，Gemini 是 /v1beta）
 * - 带了别的路径（如 /compatible-mode/v1、/api/paas/v4）：原样使用
 */
export function normalizeBase(providerId, raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) {
    s = (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(s) ? 'http://' : 'https://') + s;
  }
  s = trimBase(s.replace(/[?#].*$/, ''));
  for (const re of ENDPOINT_TAILS) s = s.replace(re, '');
  s = trimBase(s);
  let url;
  try { url = new URL(s); } catch { return s; }
  if (url.pathname === '/' || url.pathname === '') return `${url.origin}${providerOf(providerId).versionPath ?? '/v1'}`;
  return s;
}

/** 实际要用的接口地址：自定义优先，否则官方默认。 */
export function resolveBase(providerId, override) {
  return normalizeBase(providerId, override) || trimBase(providerOf(providerId).baseUrl);
}

/** 完整请求地址预览，给设置界面显示"实际会请求哪里"。 */
export function endpointPreview(providerId, override, model) {
  const base = resolveBase(providerId, override);
  if (!base) return '';
  return providerOf(providerId).endpoint(base, model || '<模型名>');
}

/** 本地转发端点是否可用（只有通过 npm start 打开页面时才有）。 */
export async function probeProxy(signal) {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
  try {
    const res = await fetch('/llm/info', { signal });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.ok ? j.providers || {} : null;
  } catch {
    return null;   // 直接打开 HTML 文件、或没跑 npm start
  }
}

/**
 * 走本地转发：浏览器只跟同源的 /llm 打交道，跨域那一跳由 node 发出。
 * 上游不带 CORS 头也没关系（本地网关、第三方中转多半都不带）。
 * 服务端配了环境变量时，key 可以留空，密钥完全不进浏览器。
 */
async function askViaProxy({ provider, key, model, system, messages, baseUrl, signal, timeoutMs }) {
  let res;
  try {
    res = await fetch('/llm', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider, key, model, system, messages, baseUrl, timeoutMs }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`连不上本地转发服务：${e.message}。确认 npm start 还在跑。`);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) throw new Error(j?.error || `转发服务返回 ${res.status}`);
  return j.reply;
}

export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 把调用方的取消信号和超时合成一个。fetch 本身没有超时：连接建立后对方迟迟不回，
 * 页面就会一直停在"正在思考"。超时与用户取消要区分开，超时给出可读的原因。
 */
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = ms > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, ms) : null;
  return {
    signal: ctrl.signal,
    timedOut: () => timedOut,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); },
  };
}

/** 这次请求实际会打到哪里，给界面显示用。 */
export function describeTarget({ provider, baseUrl, viaProxy }) {
  if (viaProxy) return '本地转发（npm start）';
  const base = resolveBase(provider, baseUrl);
  try { return `直连 ${new URL(base).host}`; } catch { return base ? `直连 ${base}` : '未填接口地址'; }
}

/**
 * 连通性测试：发一条极短的请求，量往返耗时。走的是和正式提问完全相同的路径
 * （同样的地址、密钥、模型、直连或转发），测通了就说明提问也能通。
 */
export async function testConnection(opts) {
  const t0 = performance.now();
  const reply = await ask({
    ...opts,
    system: '这是连通性测试。只回复 OK 两个字母，不要输出别的。',
    messages: [{ role: 'user', content: 'ping' }],
    timeoutMs: opts.timeoutMs ?? 45_000,
  });
  return { ms: Math.round(performance.now() - t0), reply };
}

/**
 * 发一次请求。messages 是 [{role:'user'|'assistant', content}]，system 单独传。
 * viaProxy=true 时改走本地转发端点。失败时抛出带可读中文信息的 Error。
 * timeoutMs 到点仍没收完响应就放弃；0 表示不限时。用户取消仍抛 AbortError。
 */
export async function ask({ provider, key, model, system, messages, baseUrl, signal, viaProxy, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const p = providerOf(provider);
  const t = withTimeout(signal, viaProxy && timeoutMs > 0 ? timeoutMs + 5_000 : timeoutMs);   // 转发多等 5 秒，让服务端的超时信息先回来
  const timeoutError = () => new Error(`${viaProxy ? '本地转发' : p.vendor} ${Math.round(timeoutMs / 1000)} 秒没有返回结果。可能是网络不通（请求发出去了但没有回音），或模型推理太久；先在「模型设置」里点「测试连接」看看。`);
  try {
    if (viaProxy) return await askViaProxy({ provider, key, model, system, messages, baseUrl, signal: t.signal, timeoutMs });
    return await askDirect({ p, key, model, system, messages, provider, baseUrl, signal: t.signal });
  } catch (e) {
    if (e?.name === 'AbortError' && t.timedOut()) throw timeoutError();
    throw e;
  } finally {
    t.done();
  }
}

async function askDirect({ p, key, model, system, messages, provider, baseUrl, signal }) {
  if (!key) throw new Error('还没有填 API 密钥。');
  if (!model) throw new Error('还没有填模型名。');
  const base = resolveBase(provider, baseUrl);
  if (!base) throw new Error('还没有填接口地址。');

  const url = p.endpoint(base, model);
  const headers = p.headers(key);
  const body = p.body({ model, system, messages });

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    // 浏览器不会告诉页面具体的 CORS 原因，只会给一个笼统的 TypeError
    const extra = p.netHint ? ` ${p.netHint}` : '';
    throw new Error(`连不上 ${p.vendor}：${e.message}。可能是断网、被墙，或该地址不允许浏览器直连。${extra}`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应，下面按状态码报错 */ }

  if (!res.ok) {
    const detail = (json && p.error(json)) || text.slice(0, 300) || '(无响应内容)';
    const hint = res.status === 401 || res.status === 403
      ? '密钥无效或没有权限。'
      : res.status === 429 ? '请求太频繁或额度用尽。'
      : res.status === 404 ? '模型名或接口地址可能不对。'
      : '';
    throw new Error(`${p.vendor} 返回 ${res.status}：${detail}${hint ? ' ' + hint : ''}`);
  }

  const out = p.extract(json || {});
  if (!out) throw new Error(`${p.vendor} 返回了空内容。可能是模型名不对，或被安全策略拦下。`);
  return out;
}

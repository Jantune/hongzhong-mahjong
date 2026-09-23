// 本地静态服务 + 可选的大模型转发端点。
//
// 转发端点解决两件事：
//   1. CORS。页面和转发端点同源，浏览器不做跨域检查；真正的跨域请求由 node 发出，
//      而 node 不是浏览器、不执行 CORS，所以对端不返回 access-control-* 头也没关系。
//      不带 CORS 头的上游很常见：本地网关（grok2api 之类）、各种第三方中转。
//   2. 密钥可以只放在环境变量里，页面完全不接触。
//
// 上游地址没有任何本地/远程的限制，填什么就转到什么：
//   $env:HZ_BASE_GROK = "http://127.0.0.1:8000/v1"        # 本机网关
//   $env:HZ_BASE_GROK = "https://some-relay.example/v1"   # 第三方中转
//   $env:HZ_KEY_GROK  = "..."                             # 按服务商单独配
//   $env:HZ_KEY       = "..."                             # 兜底，所有服务商共用
// 服务商名用 PROVIDERS 里的 id：claude / openai / openai-responses / gemini / grok / custom。
//
// 请求体由同一份 llm.mjs 构造，服务商必须是已知的那几个，所以这不是一个能
// 转发任意请求的开放代理；而且只监听 127.0.0.1。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, providerOf, ask } from './llm.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
};

const envName = (id) => id.replace(/-/g, '_').toUpperCase();
const envKey = (id) => process.env[`HZ_KEY_${envName(id)}`] || process.env.HZ_KEY || '';
const envBase = (id) => process.env[`HZ_BASE_${envName(id)}`] || '';

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json;charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 告诉页面哪些服务商在服务端配好了密钥/地址，配好的页面就不用再填。 */
function info() {
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) {
    providers[id] = { key: !!envKey(id), baseUrl: envBase(id) };
  }
  return { ok: true, providers };
}

async function handleLlm(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch (error) {
    return sendJson(res, 400, { error: `请求体不是合法 JSON：${error.message}` });
  }

  const id = String(payload.provider || '');
  if (!Object.hasOwn(PROVIDERS, id)) {
    return sendJson(res, 400, { error: `未知服务商 ${id || '(空)'}` });
  }
  // 环境变量优先，这样密钥可以完全不进浏览器
  const key = envKey(id) || payload.key || '';
  const baseUrl = envBase(id) || payload.baseUrl || providerOf(id).baseUrl;

  try {
    const reply = await ask({
      provider: id,
      key,
      model: payload.model,
      system: payload.system,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      baseUrl,
      // 页面传来的超时，夹在 5 秒到 10 分钟之间；不传就用 ask 的默认值
      ...(Number.isFinite(payload.timeoutMs) ? { timeoutMs: Math.min(600_000, Math.max(5_000, payload.timeoutMs)) } : {}),
    });
    sendJson(res, 200, { ok: true, reply });
  } catch (error) {
    // ask() 抛出的信息已经是中文，且不含密钥
    sendJson(res, 502, { error: error?.message || String(error) });
  }
}

async function serveStatic(res, pathname) {
  // 规范化之后仍须以 root 打头，挡住 ../ 穿越
  const target = normalize(join(root, decodeURIComponent(pathname)));
  if (!target.startsWith(normalize(root))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  if (pathname === '/llm/info') return sendJson(res, 200, info());
  if (pathname === '/llm') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      return res.end('Method not allowed');
    }
    return handleLlm(req, res);
  }

  if (pathname === '/') pathname = '/index.html';
  return serveStatic(res, pathname);
}).listen(port, '127.0.0.1', () => {
  const ready = Object.entries(info().providers).filter(([, v]) => v.key).map(([k]) => k);
  console.log(`Hong Zhong Mahjong  http://127.0.0.1:${port}`);
  console.log(`转发端点 POST /llm  ${ready.length ? `服务端已配密钥：${ready.join(', ')}` : '（未配服务端密钥，将用页面里填的）'}`);
});

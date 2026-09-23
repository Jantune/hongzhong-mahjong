import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle this app's acyclic ES modules as data URLs. Identical URLs preserve
// module identity; no file-origin module fetches or local server are required.
const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'dist');
const cache = new Map();
const visiting = new Set();
function moduleUrl(file) {
  if (cache.has(file)) return cache.get(file);
  if (visiting.has(file)) throw new Error(`Circular module dependency: ${file}`);
  visiting.add(file);
  let code = readFileSync(file, 'utf8');
  code = code.replace(/\bfrom\s*(['"])(\.\/[^'"]+\.mjs)\1/g,
    (_, quote, dependency) => `from ${quote}${moduleUrl(resolve(dirname(file), dependency))}${quote}`);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  visiting.delete(file);
  cache.set(file, url);
  return url;
}
const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="style.css">',
    () => `<style>${readFileSync(join(root, 'style.css'), 'utf8')}</style>`)
  .replace('<script type="module" src="app.mjs"></script>',
    () => `<script type="module" src="${moduleUrl(join(root, 'app.mjs'))}"></script>`);
if (html.includes('href="style.css"') || html.includes('src="app.mjs"')) {
  throw new Error('External application assets were not embedded');
}
mkdirSync(output, { recursive: true });
const target = join(output, 'hongzhong-mahjong.html');
writeFileSync(target, html, 'utf8');
writeFileSync(join(output, '开始玩.txt'), '\uFEFF红中牌室 · 离线版\r\n\r\n1. 解压整个压缩包。\r\n2. 双击 hongzhong-mahjong.html，用 Edge、Chrome 或其他现代浏览器打开。\r\n3. 你操作南家，其他三家由电脑控制；点选手牌，再点按钮或按回车出牌。\r\n\r\n无需安装软件、无需启动服务器，可以断网玩。\r\n这是单人对战电脑，不是四人联网联机。\r\n分数仅保存在当前页面，刷新或关闭后重置。\r\n手机如无法直接打开本地 HTML，可改用电脑，或请分享者提供网页链接。\r\n', 'utf8');
console.log(`Built ${target} (${Math.ceil(Buffer.byteLength(html) / 1024)} KiB)`);

import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep each ES module as one data URL and connect them with an import map.
// This avoids recursively embedding shared modules in every importer.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const modules = new Map();
const visiting = new Set();
const dependencyPattern = /(?:from\s*|import\s*)['"](\.\/[^'"]+\.mjs)['"]/g;
function moduleKey(file) { return `hz:${relative(root, file).replaceAll('\\', '/')}`; }
function collect(file) {
  file = resolve(file);
  if (modules.has(file)) return;
  if (visiting.has(file)) throw new Error(`Circular module dependency: ${file}`);
  visiting.add(file);
  const code = readFileSync(file, 'utf8');
  // 先把依赖列表取全再递归：全局正则的 lastIndex 是共享状态，边 exec 边递归会被子调用重置，
  // 之前就因此漏掉了 tiles.mjs → tile-assets.mjs，产物里缺模块，页面整个加载失败
  const deps = [...code.matchAll(dependencyPattern)].map((m) => resolve(dirname(file), m[1]));
  for (const dep of deps) collect(dep);
  modules.set(file, code);
  visiting.delete(file);
}
const entry = join(root, 'src/app.mjs');
collect(entry);
const importMap = {};
for (const [file, source] of modules) {
  const rewritten = source.replace(/(['"])(\.\/[^'"]+\.mjs)\1/g,
    (_, quote, dependency) => `${quote}${moduleKey(resolve(dirname(file), dependency))}${quote}`);
  importMap[moduleKey(file)] = `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`;
}

// 每个被引用的 hz: 模块都必须在 import map 里，否则浏览器端整页加载失败
for (const [file, source] of modules) {
  for (const m of source.matchAll(/(['"])(\.\/[^'"]+\.mjs)\1/g)) {
    const key = moduleKey(resolve(dirname(file), m[2]));
    if (!importMap[key]) throw new Error(`${moduleKey(file)} 引用了 ${key}，但它没有被打包`);
  }
}

function audioBundle() {
  const manifest = JSON.parse(readFileSync(join(root, 'assets/audio/voice/manifest.json'), 'utf8'));
  const files = {};
  for (const seat of ['s0', 's1', 's2', 's3']) for (const id of Object.keys(manifest.clips[seat] || {})) {
    const path = `voice/${seat}/${id}.mp3`;
    files[path] = `data:audio/mpeg;base64,${readFileSync(join(root, 'assets/audio', path)).toString('base64')}`;
  }
  for (const path of ['voice/narrator/draw.mp3', 'sfx/tile1.mp3', 'sfx/tile2.mp3', 'sfx/tile3.mp3', 'sfx/tile4.mp3', 'sfx/shuffle.mp3', 'ambience/parlor.mp3']) {
    files[path] = `data:audio/mpeg;base64,${readFileSync(join(root, 'assets/audio', path)).toString('base64')}`;
  }
  return JSON.stringify({ manifest, files });
}
const audioJson = audioBundle();
const html = readFileSync(join(root, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="style.css">',
    () => `<style>${readFileSync(join(root, 'style.css'), 'utf8')}</style>`)
  .replace('<script type="module" src="src/app.mjs"></script>', () => [
    `<script type="application/json" id="hz-audio">${audioJson}</script>`,
    `<script type="importmap">${JSON.stringify({ imports: importMap })}</script>`,
    // 入口必须写成内联 import：<script src> 的地址不经过 import map，hz: 会被当成网络协议
    `<script type="module">import "${moduleKey(entry)}";</script>`,
  ].join(''));
if (html.includes('href="style.css"') || html.includes('src="src/app.mjs"')) {
  throw new Error('External application assets were not embedded');
}
mkdirSync(output, { recursive: true });
const target = join(output, 'hongzhong-mahjong.html');
writeFileSync(target, html, 'utf8');
copyFileSync(target, join(output, '红中牌室-手机版.html'));
writeFileSync(join(output, '开始玩.txt'), '\uFEFF红中牌室 · 离线版\r\n\r\n1. 解压整个压缩包。\r\n2. 双击 hongzhong-mahjong.html，用 Edge、Chrome 或其他现代浏览器打开。\r\n3. 你操作南家，其他三家由电脑控制；点选手牌，再点按钮或按回车出牌。\r\n\r\n无需安装软件、无需启动服务器，可以断网玩。\r\n这是单人对战电脑，不是四人联网联机。\r\n分数仅保存在当前页面，刷新或关闭后重置。\r\n手机如无法直接打开本地 HTML，可改用电脑，或请分享者提供网页链接。\r\n', 'utf8');
console.log(`Built ${target}`);
console.log(`Total size: ${Buffer.byteLength(html)} bytes; audio: ${Buffer.byteLength(audioJson)} bytes`);
console.log(`Embedded modules: ${modules.size}; each appears once in the import map`);

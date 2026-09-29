const fs = require('fs');
const path = require('path');

const tileNames = [
  'Man1','Man2','Man3','Man4','Man5','Man6','Man7','Man8','Man9',
  'Sou1','Sou2','Sou3','Sou4','Sou5','Sou6','Sou7','Sou8','Sou9',
  'Pin1','Pin2','Pin3','Pin4','Pin5','Pin6','Pin7','Pin8','Pin9',
  'Ton','Nan','Shaa','Pei','Chun','Hatsu','Haku'
];

async function main() {
  const symbols = [];

  for (let i = 0; i < tileNames.length; i++) {
    const name = tileNames[i];
    if (name === 'Haku') {
      // Classic Chinese Bai Ban (White Dragon) with double frame
      symbols.push(`  <symbol id="tile-${i}" viewBox="0 0 300 400">
    <g transform="translate(0,-652.36216)">
      <rect x="42" y="697" width="216" height="310" rx="22" fill="none" stroke="#254f77" stroke-width="18" />
      <rect x="58" y="713" width="184" height="278" rx="14" fill="none" stroke="#254f77" stroke-width="4" stroke-opacity="0.75" />
    </g>
  </symbol>`);
      continue;
    }

    const file = path.join(__dirname, '..', 'assets', 'tiles', `${name}.svg`);
    const content = fs.readFileSync(file, 'utf8');

    // Extract layer1 content
    const layerMatch = content.match(/<g[^>]+id="layer1"[^>]*>([\s\S]*?)<\/g>\s*<\/svg>/);
    if (!layerMatch) {
      console.warn('No layer1 for', name);
      continue;
    }

    let inner = layerMatch[1];
    // Clean up Inkscape metadata
    inner = inner
      .replace(/\s*(?:inkscape|sodipodi):[a-z\-]+="[^"]*"/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    symbols.push(`  <symbol id="tile-${i}" viewBox="0 0 300 400">
    <g transform="translate(0,-652.36216)">
      ${inner}
    </g>
  </symbol>`);
  }

  // Add Back symbol (classic jade green textured tile back)
  symbols.push(`  <symbol id="tile-back" viewBox="0 0 300 400">
    <rect x="12" y="12" width="276" height="376" rx="28" fill="#1b5e43" stroke="#2b7e5b" stroke-width="8"/>
    <rect x="26" y="26" width="248" height="348" rx="20" fill="none" stroke="#36966e" stroke-width="4" stroke-opacity="0.6"/>
    <path d="M40 40 L260 360 M40 360 L260 40" stroke="#144d36" stroke-width="2" stroke-opacity="0.3"/>
  </symbol>`);

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" id="mahjong-tile-sprite">\n<defs>\n${symbols.join('\n')}\n</defs>\n</svg>`;
  
  const jsContent = `/* Auto-generated SVG Sprite containing all 34 Mahjong tiles + Back */
export const TILE_SPRITE_SVG = ${JSON.stringify(sprite)};

export function ensureTileSprite() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('mahjong-tile-sprite')) return;
  const div = document.createElement('div');
  div.innerHTML = TILE_SPRITE_SVG;
  document.body.prepend(div.firstElementChild);
}
`;

  fs.writeFileSync(path.join(__dirname, '..', 'src', 'tile-assets.mjs'), jsContent, 'utf8');
  console.log('Successfully wrote tile-assets.mjs, length:', jsContent.length);
}

main();

import { NAMES } from './game.mjs';
import { ensureTileSprite } from './tile-assets.mjs';

export const TILE_NAMES = NAMES;

export function tileMarkup(state, id, { back = false, compact = false, selected = false, disabled = false } = {}) {
  ensureTileSprite();
  if (back || id === null || id === undefined) {
    return `<span class="tile tile-back${compact ? ' tile-compact' : ''}" aria-hidden="true"><svg class="tile-art" viewBox="0 0 300 400"><use href="#tile-back"/></svg></span>`;
  }
  const type = Math.floor(Number(id) / 4);
  const indType = state?.indicatorType ?? (state?.indicator !== undefined ? Math.floor(Number(state.indicator) / 4) : -1);
  const skin = type === 31 || type === indType;
  const joker = type === state?.joker;
  const classes = [
    'tile',
    compact && 'tile-compact',
    selected && 'selected',
    disabled && 'disabled',
    skin && 'skin-tile',
    joker && 'joker-tile'
  ].filter(Boolean).join(' ');
  const tag = skin ? '皮' : joker ? '赖' : '';
  const title = `${NAMES[type] ?? ''}${tag ? ' · ' + tag : ''}`;
  return `<span class="${classes}" data-type="${type}" title="${title}"><svg class="tile-art" viewBox="0 0 300 400"><use href="#tile-${type}"/></svg><span class="tile-caption">${NAMES[type] ?? ''}</span>${tag ? `<b class="tile-tag">${tag}</b>` : ''}</span>`;
}

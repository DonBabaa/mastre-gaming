import { coverUrl, type CatalogGame } from './catalog';
import { el, hueOf } from './dom';

/**
 * A 16:9 cover. The title on a coloured panel sits underneath, so a game with
 * no cover (or one that fails to load) still gets a tile that looks deliberate.
 */
export function coverBox(game: CatalogGame, eager = false): HTMLDivElement {
  const box = el(
    'div',
    { class: 'cover', style: `--hue:${hueOf(game.id)}` },
    el('span', { class: 'cover__fallback', 'aria-hidden': 'true' }, game.title),
  );
  const url = coverUrl(game);
  if (url) {
    const image = el('img', { src: url, alt: '', decoding: 'async', loading: eager ? 'eager' : 'lazy' });
    image.addEventListener('error', () => image.remove());
    box.append(image);
  }
  return box;
}

import { coverUrl, lastChange, loadCatalog, playUrl, type Catalog, type CatalogGame } from './lib/catalog';
import { coverBox } from './lib/cover';
import { byId, controlIcon, el, present, timeAgo } from './lib/dom';
import { getLastPlayed } from './lib/storage';
import { setupUpdatePanel } from './lib/updater';

const grid = byId('grid');
const notice = byId('notice');
const toolbar = byId('toolbar');
const search = byId<HTMLInputElement>('search');
const tagBar = byId('tags');
const count = byId('count');

const state = {
  games: [] as CatalogGame[],
  query: '',
  tags: new Set<string>(),
};

/** Lowercase and without accents, so "pokemon" finds "Pokémon". */
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// ───────────────────────────── cards ─────────────────────────────

function card(game: CatalogGame): HTMLElement {
  const slot = String(state.games.indexOf(game) + 1).padStart(2, '0');
  const art = coverBox(game);
  art.append(
    ...present(
      el('span', { class: 'card__slot', 'aria-hidden': 'true' }, slot),
      game.stale &&
        el('span', { class: 'badge badge--stale', title: game.error ?? 'The newest version failed to build.' }, 'Stale build'),
      el('span', { class: 'card__play', 'aria-hidden': 'true' }, 'Play'),
    ),
  );

  const when = lastChange(game);
  return el(
    'a',
    { class: 'card', href: playUrl(game) },
    art,
    el(
      'div',
      { class: 'card__body' },
      el('h2', { class: 'card__title' }, game.title),
      el('p', { class: 'card__by' }, `by ${game.authors.join(', ')}`),
      el('p', { class: 'card__desc' }, game.description),
      el('ul', { class: 'card__tags' }, ...game.tags.slice(0, 5).map((tag) => el('li', {}, tag))),
      el(
        'p',
        { class: 'card__meta' },
        el('time', { datetime: new Date(when).toISOString() }, `Updated ${timeAgo(when)}`),
        el('span', { class: 'card__controls' }, ...game.controls.map(controlIcon)),
      ),
    ),
  );
}

function showNotice(title: string, text: string, action?: HTMLElement): void {
  notice.replaceChildren(...present(el('h2', {}, title), el('p', {}, text), action));
  notice.hidden = false;
}

function button(labelText: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { class: 'button button--plain', type: 'button' }, labelText);
  node.addEventListener('click', onClick);
  return node;
}

// ───────────────────────────── filters ─────────────────────────────

function visibleGames(): CatalogGame[] {
  const query = fold(state.query.trim());
  return state.games.filter((game) => {
    if (![...state.tags].every((tag) => game.tags.includes(tag))) return false;
    if (!query) return true;
    return fold([game.title, game.description, ...game.authors, ...game.tags].join(' ')).includes(query);
  });
}

function chip(labelText: string, pressed: boolean, onClick: () => void, total?: number): HTMLButtonElement {
  const node = el(
    'button',
    { class: 'chip', type: 'button', 'aria-pressed': String(pressed) },
    labelText,
    total !== undefined && el('span', { class: 'chip__n' }, String(total)),
  );
  node.addEventListener('click', onClick);
  return node;
}

function renderTags(): void {
  const totals = new Map<string, number>();
  for (const game of state.games) {
    for (const tag of game.tags) totals.set(tag, (totals.get(tag) ?? 0) + 1);
  }
  const sorted = [...totals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  tagBar.replaceChildren(
    chip('All', state.tags.size === 0, () => {
      state.tags.clear();
      render();
    }),
    ...sorted.map(([tag, total]) =>
      chip(
        tag,
        state.tags.has(tag),
        () => {
          if (!state.tags.delete(tag)) state.tags.add(tag);
          render();
        },
        total,
      ),
    ),
  );
}

function clearFilters(): void {
  state.query = '';
  state.tags.clear();
  search.value = '';
  render();
}

function render(): void {
  renderTags();
  const games = visibleGames();
  grid.replaceChildren(...games.map(card));
  grid.hidden = games.length === 0;
  notice.hidden = true;

  const filtering = state.query.trim() !== '' || state.tags.size > 0;
  count.textContent = filtering ? `${games.length} of ${state.games.length}` : '';

  if (games.length === 0) {
    showNotice('Nothing matches', 'No game fits that search. Try fewer words or another tag.', button('Clear filters', clearFilters));
  }
}

// ───────────────────────────── page furniture ─────────────────────────────

function renderContinue(): void {
  const last = getLastPlayed();
  const game = last && state.games.find((candidate) => candidate.id === last.id);
  if (!last || !game) return;

  const section = byId('continue');
  const link = el(
    'a',
    { class: 'continue__card', href: playUrl(game) },
    coverBox(game, true),
    el(
      'div',
      { class: 'continue__text' },
      el('p', { class: 'eyebrow' }, 'Continue'),
      el('h2', { class: 'continue__title' }, game.title),
      el('p', { class: 'continue__when' }, `Last played ${timeAgo(last.at)}`),
      el('span', { class: 'button' }, 'Resume'),
    ),
  );
  // An absolute URL: a relative one inside a CSS variable is resolved from the stylesheet's folder, not the page's.
  const art = coverUrl(game);
  if (art) link.style.setProperty('--art', `url("${new URL(art, document.baseURI).href}")`);
  section.replaceChildren(link);
  section.hidden = false;
}

function renderTicker(): void {
  const words = state.games.length
    ? [...state.games.map((game) => game.title), 'Press start']
    : ['Insert coin', 'Press start', 'Games made by friends'];
  // Enough copies to fill a wide screen, then doubled so the loop has no seam.
  const run: string[] = [];
  while (run.length < 14) run.push(...words);
  byId('ticker').replaceChildren(...[...run, ...run].map((word) => el('span', {}, word)));
}

function renderHeader(catalog: Catalog): void {
  byId('stat-games').textContent = String(catalog.games.length).padStart(2, '0');
  const newest = Math.max(0, ...catalog.games.map(lastChange));
  byId('stat-updated').textContent = newest ? timeAgo(newest) : '-';
  byId('stats').hidden = catalog.games.length === 0;

  const meta = byId('foot-meta');
  const repo = catalog.hub?.repo;
  meta.replaceChildren(
    ...present(
      repo && el('a', { href: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`, rel: 'noopener' }, 'Add your game'),
      catalog.hub?.sha && el('span', {}, `hub ${catalog.hub.sha.slice(0, 7)}`),
    ),
  );
}

function contributeLink(catalog: Catalog): HTMLElement | undefined {
  const repo = catalog.hub?.repo;
  if (!repo) return undefined;
  return el('a', { class: 'button button--plain', href: `https://github.com/${repo}/blob/main/CONTRIBUTING.md`, rel: 'noopener' }, 'How to add a game');
}

// ───────────────────────────── start ─────────────────────────────

let shown: Catalog | null = null;

/** Puts a catalog on the page. Also used when the update panel brings a newer one. */
function apply(catalog: Catalog): void {
  shown = catalog;
  state.games = [...catalog.games].sort((a, b) => lastChange(b) - lastChange(a));
  renderHeader(catalog);
  renderTicker();

  if (state.games.length === 0) {
    grid.hidden = true;
    toolbar.hidden = true;
    showNotice(
      'No games loaded yet',
      'This shelf is empty. Games show up here as soon as one is added to the hub.',
      contributeLink(catalog),
    );
    return;
  }

  toolbar.hidden = false;
  renderContinue();
  render();
}

async function start(): Promise<void> {
  renderTicker();
  setupUpdatePanel(() => shown, apply);

  let catalog: Catalog;
  try {
    catalog = await loadCatalog();
  } catch {
    grid.hidden = true;
    showNotice('The game list did not load', 'Check your connection, then try again.', button('Try again', () => location.reload()));
    return;
  }
  apply(catalog);
}

search.addEventListener('input', () => {
  state.query = search.value;
  render();
});

// "/" jumps to the search box, the way it does on most sites. Only on this page: the play page never listens to keys.
window.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== search && !event.ctrlKey && !event.metaKey && !toolbar.hidden) {
    event.preventDefault();
    search.focus();
  } else if (event.key === 'Escape' && document.activeElement === search) {
    clearFilters();
    search.blur();
  }
});

void start();

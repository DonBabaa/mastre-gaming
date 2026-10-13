import { gameUrl, loadCatalog, type Catalog, type CatalogGame } from './lib/catalog';
import { coverBox } from './lib/cover';
import { byId, el } from './lib/dom';
import { onGameMessage } from './lib/messages';
import { setLastPlayed } from './lib/storage';

/** The loading screen never stays longer than this, ready or not. */
const READY_TIMEOUT_MS = 10_000;
/** ...and never flashes by faster than this. */
const MIN_LOADING_MS = 350;
/** How long the back button stays before it fades. */
const BACK_VISIBLE_MS = 2_000;
/** Moving the mouse this close to the top edge brings the back button back. */
const NEAR_TOP_PX = 72;

const back = byId<HTMLAnchorElement>('back');
const goHome = () => location.assign('./');

function showProblem(title: string, text: string): void {
  document.title = `${title} · Mastre Gaming`;
  document.body.append(
    el(
      'main',
      { class: 'oops' },
      el('p', { class: 'eyebrow' }, 'Mastre Gaming'),
      el('h1', {}, title),
      el('p', {}, text),
      el('a', { class: 'button button--plain', href: './' }, 'All games'),
    ),
  );
}

function loadingScreen(game: CatalogGame): HTMLElement {
  return el(
    'div',
    { class: 'loading', role: 'status' },
    el(
      'div',
      { class: 'loading__box' },
      coverBox(game, true),
      el('p', { class: 'eyebrow' }, 'Loading'),
      el('h1', { class: 'loading__title' }, game.title),
      el('div', { class: 'loading__bar' }),
      game.stale && el('p', { class: 'loading__hint' }, 'The newest version failed to build. This is the last one that worked.'),
    ),
  );
}

/**
 * The back button fades out so it never sits on top of a game, and returns when
 * the mouse comes near the top of the screen.
 *
 * The hub adds no keyboard listeners here, on purpose: every key, Escape
 * included, belongs to the game.
 */
function setupBackButton(frame: HTMLIFrameElement, focusGame: () => void) {
  let timer = 0;

  const hide = () => {
    if (back.matches(':hover, :focus-visible')) {
      arm();
      return;
    }
    back.classList.add('is-hidden');
    // A click on the button area takes focus away from the game. Hand it back.
    if (document.activeElement !== frame) focusGame();
  };
  const arm = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, BACK_VISIBLE_MS);
  };
  const show = () => {
    back.classList.remove('is-hidden');
    arm();
  };

  window.addEventListener('mousemove', (event) => event.clientY <= NEAR_TOP_PX && show(), { passive: true });
  show();

  /**
   * The mouse is over the game almost all the time, and a frame keeps its mouse
   * events to itself. The game is on our own site, so we may listen inside it:
   * passively, at the window, without touching any event.
   */
  const watchGame = () => {
    try {
      const view = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!view || !doc) return;
      const listening = { passive: true, capture: true } as const;
      view.addEventListener('mousemove', (event) => {
        if (!doc.pointerLockElement && event.clientY <= NEAR_TOP_PX) show();
      }, listening);
      view.addEventListener('touchstart', (event) => {
        const touch = event.touches[0];
        if (touch && touch.clientY <= NEAR_TOP_PX) show();
      }, listening);
      doc.documentElement.addEventListener('mouseleave', (event) => event.clientY <= 0 && show(), { passive: true });
    } catch {
      // The game sent its frame to another site. The button still shows on every load.
    }
    show();
  };

  return { watchGame };
}

function play(game: CatalogGame): void {
  document.title = `${game.title} · Mastre Gaming`;
  setLastPlayed(game.id);

  const loading = loadingScreen(game);
  const frame = el('iframe', {
    class: 'stage',
    title: game.title,
    // Same origin, so no sandbox: the game gets its storage, and later the shared login.
    allow: 'fullscreen; gamepad; autoplay; clipboard-write',
  });

  const focusGame = () => {
    try {
      frame.focus({ preventScroll: true });
      frame.contentWindow?.focus();
    } catch {
      // Nothing to do: the player's first click focuses the game anyway.
    }
  };

  const shownAt = performance.now();
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    window.clearTimeout(giveUp);
    window.setTimeout(() => {
      loading.classList.add('is-done');
      window.setTimeout(() => loading.remove(), 450);
      focusGame();
    }, Math.max(0, MIN_LOADING_MS - (performance.now() - shownAt)));
  };
  const giveUp = window.setTimeout(reveal, READY_TIMEOUT_MS);

  onGameMessage(frame, { ready: reveal, exit: goHome });

  const { watchGame } = setupBackButton(frame, focusGame);
  frame.addEventListener('load', () => {
    watchGame();
    focusGame();
    // A game that never says "ready" is shown as soon as its page has loaded.
    if (!game.signals?.ready) reveal();
  });

  // Coming back to the tab should put the keyboard back in the game.
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) focusGame();
  });

  frame.src = gameUrl(game);
  document.body.prepend(frame, loading);
  focusGame();
}

async function start(): Promise<void> {
  const id = new URLSearchParams(location.search).get('id')?.trim() ?? '';
  if (!id) {
    showProblem('No game picked', 'This page needs to know which game to start.');
    return;
  }

  let catalog: Catalog;
  try {
    catalog = await loadCatalog();
  } catch {
    showProblem('The game list did not load', 'Check your connection, then reload this page.');
    return;
  }

  const game = catalog.games.find((candidate) => candidate.id === id);
  if (!game) {
    showProblem('Game not found', `There is no game called "${id}" here. It may have been renamed or removed.`);
    return;
  }
  play(game);
}

void start();

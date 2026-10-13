/** The shape of dist/catalog.json, written by scripts/build-games.mjs. */

export type Control = 'keyboard' | 'mouse' | 'gamepad' | 'touch';

export interface CatalogGame {
  id: string;
  title: string;
  description: string;
  authors: string[];
  version: string;
  tags: string[];
  controls: Control[];
  /** HTML file inside the game's folder that starts it. */
  entry: string;
  /** Folder of the game, relative to the hub root: "games/<id>/". */
  path: string;
  /** Cover image relative to the hub root, or null when the game has none. */
  cover: string | null;
  multiplayer: { server: string | null };
  /** Commit of the build that is being served. */
  sha: string;
  builtAt: string;
  /** Date of that commit. */
  updatedAt: string | null;
  /** True when a newer commit failed to build and this is the last one that worked. */
  stale: boolean;
  error: string | null;
  sourceRepo: string;
  /** Which postMessage signals the build was found to send. */
  signals?: { ready: boolean; exit: boolean };
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  hub: { repo: string | null; sha: string | null };
  games: CatalogGame[];
}

export async function loadCatalog(): Promise<Catalog> {
  // Relative on purpose: the hub may live under a subpath.
  const response = await fetch('./catalog.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`catalog.json: HTTP ${response.status}`);
  const catalog = (await response.json()) as Catalog;
  if (!Array.isArray(catalog.games)) throw new Error('catalog.json has no games list');
  return catalog;
}

/** Where the game itself lives. */
export function gameUrl(game: CatalogGame): string {
  return game.entry === 'index.html' ? game.path : `${game.path}${game.entry}`;
}

/** The hub page that wraps the game. */
export function playUrl(game: CatalogGame): string {
  return `play.html?id=${encodeURIComponent(game.id)}`;
}

/** Cover URL, changing with every build so a new cover is never hidden by the browser cache. */
export function coverUrl(game: CatalogGame): string | null {
  return game.cover ? `${game.cover}?v=${game.sha.slice(0, 8)}` : null;
}

export function lastChange(game: CatalogGame): number {
  return Date.parse(game.updatedAt ?? game.builtAt) || 0;
}

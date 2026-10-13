/**
 * The hub's own storage. Every game on the site shares this origin, so the hub
 * keeps to the "mastre:hub:" prefix the same way each game keeps to "mastre:<id>:".
 *
 * Roadmap: profiles and cross-game stats will go through here first, then move
 * behind the shared backend without the pages having to change.
 */
const PREFIX = 'mastre:hub:';

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage can be full or blocked. The launcher works without it.
  }
}

export interface LastPlayed {
  id: string;
  at: number;
}

export function getLastPlayed(): LastPlayed | null {
  const last = read<LastPlayed>('last');
  return last && typeof last.id === 'string' && typeof last.at === 'number' ? last : null;
}

export function setLastPlayed(id: string): void {
  write('last', { id, at: Date.now() } satisfies LastPlayed);
}

/**
 * Messages a game may post to the hub with window.parent.postMessage().
 * Both are optional for the game.
 *
 * Roadmap: this file is where the hub side of the future `window.mastre` SDK
 * plugs in. New message types (score, presence, ...) get added to the union and
 * handled here, and the play page does not need to know how they travel.
 */
export type GameMessage = { type: 'mastre:ready' } | { type: 'mastre:exit' };

export interface GameHandlers {
  /** The game has finished loading and can be shown. */
  ready?: () => void;
  /** The player chose to quit the game. */
  exit?: () => void;
}

/** Listens to one game frame. Returns a function that stops listening. */
export function onGameMessage(frame: HTMLIFrameElement, handlers: GameHandlers): () => void {
  const listener = (event: MessageEvent) => {
    // Only the game's own top window counts, and only from this site.
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'mastre:ready') handlers.ready?.();
    else if (type === 'mastre:exit') handlers.exit?.();
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

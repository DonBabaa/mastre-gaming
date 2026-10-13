type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined>;

/**
 * Builds an element. Text always goes in as text, never as HTML: titles and
 * descriptions come from other people's repos.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') node.className = String(value);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child) node.append(child);
  }
  return node;
}

/** Drops the empty slots, so `condition && element` can sit in a list of children. */
export function present(...children: Child[]): (Node | string)[] {
  return children.filter((child): child is Node | string => Boolean(child));
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

/** A stable colour angle for a game, used when it has no cover. */
export function hueOf(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });

/** "3 days ago" for recent dates, "12 Mar 2026" for older ones. */
export function timeAgo(date: number, now = Date.now()): string {
  const minutes = Math.round((date - now) / 60_000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relative.format(days, 'day');
  return absolute.format(date);
}

const CONTROL_ICONS: Record<string, string> = {
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="1.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  mouse: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v3"/>',
  gamepad: '<path d="M7 8h10a5 5 0 0 1 5 5v1a3 3 0 0 1-5.6 1.5L16 15H8l-.4.5A3 3 0 0 1 2 14v-1a5 5 0 0 1 5-5Z"/><path d="M7 11v2M6 12h2M16.5 12h.01"/>',
  touch: '<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5a1.5 1.5 0 0 1 3 0V12a1.5 1.5 0 0 1 3 0v3a6 6 0 0 1-6 6h-.5a5 5 0 0 1-4-2L5 15.5a1.4 1.4 0 0 1 2.2-1.7L9 15.5"/>',
};

/** Small line icon for a control scheme. The markup is fixed, nothing from a catalog goes in. */
export function controlIcon(control: string): HTMLElement | null {
  const paths = CONTROL_ICONS[control];
  if (!paths) return null;
  const wrap = el('span', { class: 'control', title: control, role: 'img', 'aria-label': control });
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return wrap;
}

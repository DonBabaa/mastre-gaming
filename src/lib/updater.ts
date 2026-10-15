import { UPDATER_URL } from '../config';
import { loadCatalog, type Catalog } from './catalog';
import { el } from './dom';
import { getUpdateCode, setUpdateCode } from './storage';

/**
 * The hidden "force update" panel. Nothing shows on the page: it opens with the
 * Konami code on the home page, or with #update at the end of the address (for
 * phones). The updater only acts on the right code; see updater/index.js.
 */

const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
const POLL_MS = 5000;
const GIVE_UP_MS = 20 * 60 * 1000;

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
}

interface UpdateAnswer {
  state: 'started' | 'running' | 'recent';
  run: Run | null;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${UPDATER_URL.replace(/\/+$/, '')}${path}`, init);
  return { status: response.status, body: await response.json().catch(() => ({}) as T & { error?: string }) };
}

const latestRun = async () => (await call<{ run: Run | null }>('/status')).body.run;

/** Titles of the games that are new or changed between two catalogs. */
function changedGames(before: Catalog, after: Catalog): string[] {
  const shas = new Map(before.games.map((game) => [game.id, game.sha]));
  return after.games.filter((game) => shas.get(game.id) !== game.sha).map((game) => game.title);
}

function minutesAndSeconds(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function setupUpdatePanel(getCatalog: () => Catalog | null, onUpdated: (catalog: Catalog) => void): void {
  if (!UPDATER_URL) return;

  let dialog: HTMLDialogElement | null = null;
  let busy = false;

  const build = (): HTMLDialogElement => {
    const code = el('input', {
      type: 'password',
      name: 'code',
      placeholder: 'Code',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Code',
      required: true,
      maxlength: 200,
    });
    code.value = getUpdateCode();
    const go = el('button', { class: 'button', type: 'submit' }, 'Update now');
    const status = el('div', { class: 'updater__status', role: 'status', 'aria-live': 'polite' });
    const close = el('button', { class: 'updater__close', type: 'button', 'aria-label': 'Close' }, '×');
    const form = el('form', { class: 'updater__form' }, code, go);

    const panel = el(
      'dialog',
      { class: 'updater', 'aria-labelledby': 'updater-title' },
      close,
      el('p', { class: 'eyebrow' }, 'Hub control'),
      el('h2', { id: 'updater-title' }, 'Force update'),
      el('p', { class: 'updater__text' }, 'Looks for new versions of every game and puts them online. About three minutes when something changed.'),
      form,
      status,
    );

    const say = (text: string, link?: { href: string; label: string }, working = false) => {
      status.replaceChildren(el('p', {}, text));
      if (link) status.append(el('p', {}, el('a', { href: link.href, target: '_blank', rel: 'noopener' }, link.label)));
      if (working) status.append(el('div', { class: 'updater__bar' }));
    };

    close.addEventListener('click', () => panel.close());
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      go.disabled = true;
      say('Starting…', undefined, true);
      try {
        const answer = await call<UpdateAnswer>('/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code.value }),
        });
        if (answer.status === 401) {
          say('Wrong code.');
          code.select();
          return;
        }
        if (answer.status !== 200) {
          say(answer.body.error ?? `The updater answered ${answer.status}.`);
          return;
        }
        setUpdateCode(code.value);
        await follow(answer.body, say);
      } catch {
        say('Could not reach the updater. Check the connection and try again.');
      } finally {
        busy = false;
        go.disabled = false;
      }
    });

    document.body.append(panel);
    return panel;
  };

  /** Follows the run that this press started (or joined) until it is done. */
  const follow = async (answer: UpdateAnswer, say: (text: string, link?: { href: string; label: string }, working?: boolean) => void) => {
    const before = getCatalog();
    const started = Date.now();
    let target: Run | null = answer.state === 'started' ? null : answer.run;
    const previousId = answer.state === 'started' ? (answer.run?.id ?? null) : null;
    if (answer.state === 'running') say('An update is already running. Following it…', undefined, true);
    if (answer.state === 'recent') say('An update ran less than two minutes ago. Showing how it went…', undefined, true);

    while (Date.now() - started < GIVE_UP_MS) {
      const run = await latestRun().catch(() => null);
      if (!target && run && run.id !== previousId) target = run;
      const current = target && run?.id === target.id ? run : target;

      if (current?.status === 'completed') {
        if (current.conclusion !== 'success') {
          say('The update failed. The site keeps the version it had.', { href: current.url, label: 'Details on GitHub' });
          return;
        }
        const after = await loadCatalog({ fresh: true }).catch(() => null);
        const changed = before && after ? changedGames(before, after) : [];
        if (after && changed.length) {
          onUpdated(after);
          say(`Updated: ${changed.join(', ')}.`);
        } else {
          say('Everything was already up to date.');
        }
        return;
      }

      const phase = !current ? 'Starting' : current.status === 'in_progress' ? 'Updating' : 'Waiting for GitHub';
      say(`${phase}… ${minutesAndSeconds(Date.now() - started)}`, current ? { href: current.url, label: 'Watch it on GitHub' } : undefined, true);
      await wait(POLL_MS);
    }
    say('Still running after 20 minutes.', target ? { href: target.url, label: 'Check it on GitHub' } : undefined);
  };

  const open = () => {
    dialog ??= build();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('input')?.focus();
  };

  // The Konami code, typed anywhere on the page except in a text box.
  let step = 0;
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (key === KONAMI[step]) step += 1;
    else step = key === 'ArrowUp' ? (step >= 2 ? 2 : 1) : 0;
    if (step === KONAMI.length) {
      step = 0;
      open();
    }
  });

  // #update at the end of the address, for phones. Removed again so a reload does not reopen it.
  const fromAddress = () => {
    if (location.hash !== '#update') return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    open();
  };
  window.addEventListener('hashchange', fromAddress);
  fromAddress();
}

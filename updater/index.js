/**
 * Mastre Gaming updater, a Cloudflare Worker. It starts the hub's "Deploy hub"
 * workflow, so the hub can be updated without opening GitHub.
 *
 *   POST /update  {"code": "..."}   start an update now; the code is the UPDATE_CODE secret
 *   GET  /status                    the latest deploy run: still going or not, and how it ended
 *   every 15 minutes (cron)         start an update that stops early if no game changed
 *
 * The cron is here because GitHub's own schedule for the workflow turned out to
 * run every few hours instead of every 15 minutes. Cloudflare runs crons on time.
 *
 * Secrets, set in the Cloudflare dashboard (never in this file):
 *   GITHUB_TOKEN  fine-grained token on Mastre-gaming/mastre-gaming.github.io, permission "Actions: Read and write" only
 *   UPDATE_CODE   the code to type on the hub
 */

const REPO = 'Mastre-gaming/mastre-gaming.github.io';
const WORKFLOW = 'deploy.yml';
const ALLOWED_ORIGINS = ['https://mastre-gaming.github.io', 'http://localhost:4380'];
/** No new update within this long of the last one: pressing twice starts one update. */
const QUIET_MS = 2 * 60 * 1000;
/** A wrong code waits this long before answering, to make guessing slow. */
const WRONG_CODE_DELAY_MS = 1500;

function github(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mastre-updater',
      ...init.headers,
    },
  });
}

/** The most recent run of the deploy workflow, or null. */
export async function latestRun(env) {
  const response = await github(env, `/actions/workflows/${WORKFLOW}/runs?per_page=1`);
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when asked for the latest run`);
  const run = (await response.json()).workflow_runs?.[0];
  if (!run) return null;
  return {
    id: run.id,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    url: run.html_url,
  };
}

/**
 * Starts an update unless one is running or has just been started.
 * Returns { state: 'started' | 'running' | 'recent', run }.
 */
export async function startUpdate(env, now = Date.now()) {
  const last = await latestRun(env);
  if (last && last.status !== 'completed') return { state: 'running', run: last };
  if (last && now - Date.parse(last.createdAt) < QUIET_MS) return { state: 'recent', run: last };

  const response = await github(env, `/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main', inputs: { only_if_changed: true } }),
  });
  if (response.status !== 204) throw new Error(`GitHub refused to start the update (${response.status})`);
  return { state: 'started', run: last };
}

/** Compares without stopping at the first difference, so timing says nothing about the code. */
export function sameText(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) difference |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return difference === 0;
}

function reply(request, status, body) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const origin = request.headers.get('Origin');
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = '86400';
    headers.Vary = 'Origin';
  }
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') return reply(request, 204);

    try {
      if (!env.GITHUB_TOKEN || !env.UPDATE_CODE) {
        return reply(request, 503, { error: 'The updater is not set up yet: GITHUB_TOKEN or UPDATE_CODE is missing.' });
      }
      if (pathname === '/status' && request.method === 'GET') {
        return reply(request, 200, { run: await latestRun(env) });
      }
      if (pathname === '/update' && request.method === 'POST') {
        let code = '';
        try {
          code = (await request.json())?.code ?? '';
        } catch {
          // No body or not JSON: treated as a wrong code.
        }
        if (!sameText(code, env.UPDATE_CODE)) {
          await new Promise((resolve) => setTimeout(resolve, WRONG_CODE_DELAY_MS));
          return reply(request, 401, { error: 'Wrong code.' });
        }
        return reply(request, 200, await startUpdate(env));
      }
      return reply(request, 404, { error: 'Not found.' });
    } catch (error) {
      return reply(request, 502, { error: error.message });
    }
  },

  async scheduled(_controller, env, ctx) {
    if (env.GITHUB_TOKEN) ctx.waitUntil(startUpdate(env).catch((error) => console.log(`scheduled update: ${error.message}`)));
  },
};

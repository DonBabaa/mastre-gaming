// Tests the updater against a fake GitHub: `npm test` in this folder. No network, no Cloudflare.
import worker, { sameText, startUpdate } from './index.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
  if (!ok) failures += 1;
};

/** A fake GitHub API: one list of runs, and a record of dispatches. */
function fakeGitHub(runs) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, auth: init.headers?.Authorization });
    if (String(url).includes('/dispatches')) return new Response(null, { status: 204 });
    return Response.json({ workflow_runs: runs });
  };
  return calls;
}

const env = { GITHUB_TOKEN: 'test-token', UPDATE_CODE: 'arcade-1987' };
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const run = (status, msAgo) => ({ id: 1, event: 'push', status, conclusion: status === 'completed' ? 'success' : null, created_at: ago(msAgo), html_url: 'https://github.com/x' });
const post = (body, origin = 'https://mastre-gaming.github.io') =>
  new Request('https://updater.example/update', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

console.log('startUpdate');
let calls = fakeGitHub([run('completed', 10 * 60 * 1000)]);
let result = await startUpdate(env);
const dispatch = calls.find((call) => call.url.includes('/dispatches'));
check('starts the workflow when the last run is finished and old', result.state === 'started' && Boolean(dispatch));
check('asks it to stop early if nothing changed', JSON.parse(dispatch?.body ?? '{}').inputs?.only_if_changed === true);
check('sends the token', dispatch?.auth === 'Bearer test-token');

calls = fakeGitHub([run('in_progress', 30 * 1000)]);
result = await startUpdate(env);
check('does not start a second one while one is running', result.state === 'running' && !calls.some((call) => call.url.includes('/dispatches')));

calls = fakeGitHub([run('completed', 30 * 1000)]);
result = await startUpdate(env);
check('does not start one within two minutes of the last', result.state === 'recent' && !calls.some((call) => call.url.includes('/dispatches')));

console.log('\nPOST /update');
fakeGitHub([run('completed', 10 * 60 * 1000)]);
let response = await worker.fetch(post({ code: 'arcade-1987' }), env);
check('the right code starts an update', response.status === 200 && (await response.json()).state === 'started');
check('the hub may read the answer (CORS)', response.headers.get('Access-Control-Allow-Origin') === 'https://mastre-gaming.github.io');

calls = fakeGitHub([run('completed', 10 * 60 * 1000)]);
const started = Date.now();
response = await worker.fetch(post({ code: 'nope' }), env);
check('a wrong code is refused', response.status === 401 && !calls.some((call) => call.url.includes('/dispatches')));
check('...after a delay', Date.now() - started >= 1400);

response = await worker.fetch(new Request('https://updater.example/update', { method: 'POST', body: 'not json' }), env);
check('a request without a code is refused', response.status === 401);

response = await worker.fetch(post({ code: 'arcade-1987' }, 'https://evil.example'), env);
check('other websites get no CORS header', !response.headers.get('Access-Control-Allow-Origin'));

response = await worker.fetch(post({ code: 'arcade-1987' }), { GITHUB_TOKEN: 'x' });
check('without its secrets it says it is not set up', response.status === 503);

console.log('\nGET /status');
fakeGitHub([run('in_progress', 5000)]);
response = await worker.fetch(new Request('https://updater.example/status', { headers: { Origin: 'https://mastre-gaming.github.io' } }), env);
const status = await response.json();
check('reports the latest run', response.status === 200 && status.run?.status === 'in_progress');

console.log('\nsameText');
check('equal texts match', sameText('abc', 'abc'));
check('different texts do not', !sameText('abc', 'abd') && !sameText('abc', 'abcd') && !sameText('', 'a'));

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);

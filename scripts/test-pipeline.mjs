#!/usr/bin/env node
/**
 * End-to-end test of the build pipeline: `npm test`.
 *
 * Makes throwaway git repos on disk that stand in for friends' GitHub repos
 * (through MASTRE_GIT_BASE), runs the real pipeline against them, and checks
 * what comes out. Nothing touches the network, the real cache or dist/.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib/paths.mjs';
import { startStaticServer } from './lib/static.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mastre-test-'));
const remotes = path.join(tmp, 'remotes');
const work = path.join(tmp, 'work');
const dist = path.join(tmp, 'dist');
const cache = path.join(tmp, 'cache');
const registry = path.join(tmp, 'games.json');

const baseEnv = {
  ...process.env,
  MASTRE_GIT_BASE: `${pathToFileURL(remotes).href}/`,
  MASTRE_CACHE_DIR: cache,
  MASTRE_DIST_DIR: dist,
  MASTRE_BUILD_TIMEOUT_MS: '4000',
  // Stand-ins for secrets. No game build may ever see them.
  MASTRE_READ_TOKEN: 'test-read-token',
  SUPER_SECRET: 'do-not-leak',
  GITHUB_SHA: 'hubsha0001',
  NO_COLOR: '1',
};
delete baseEnv.GITHUB_ACTIONS;
delete baseEnv.GITHUB_OUTPUT;
delete baseEnv.GITHUB_STEP_SUMMARY;
delete baseEnv.GITHUB_REPOSITORY;
delete baseEnv.MASTRE_HUB_URL;

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=Mastre Test', '-c', 'user.email=test@mastre.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

/** Creates or updates the fake remote "friend/<name>" with these files, as one new commit on main. */
function push(name, files) {
  const bare = path.join(remotes, 'friend', `${name}.git`);
  const tree = path.join(work, name);
  if (!fs.existsSync(bare)) {
    fs.mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(bare, 'config', 'uploadpack.allowFilter', 'true');
    git(bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    fs.mkdirSync(tree, { recursive: true });
    git(tree, 'init', '-q', '-b', 'main');
  }
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(tree, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  git(tree, 'add', '-A');
  git(tree, 'commit', '-q', '-m', `update ${name}`);
  git(tree, 'push', '-q', bare, 'HEAD:main');
  return git(tree, 'rev-parse', 'HEAD').trim();
}

const manifest = (id, extra = {}) => ({
  schemaVersion: 1,
  id,
  title: `Game ${id}`,
  description: 'A test game.',
  authors: ['Tester'],
  version: '1.0.0',
  cover: 'cover.png',
  tags: ['Test'],
  controls: ['keyboard'],
  build: null,
  entry: 'index.html',
  multiplayer: { server: null },
  ...extra,
});

const page = (body) => `<!doctype html><title>t</title>${body}`;
const withBuild = { install: null, command: 'node build.mjs', output: 'dist' };
const buildScript = (html) => `
import fs from 'node:fs';
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', ${JSON.stringify(page(html))});
fs.writeFileSync('dist/env.txt', Object.entries(process.env).map(([key, value]) => key + '=' + value).join('\\n'));
`;

/** Runs the pipeline. Not spawnSync: the test serves the "deployed" catalog from this same process. */
function run(args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-games.mjs'), '--registry', registry, ...args], {
      cwd: ROOT,
      env: { ...baseEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

const readCatalog = () => JSON.parse(fs.readFileSync(path.join(dist, 'catalog.json'), 'utf8'));
const game = (id) => readCatalog().games.find((entry) => entry.id === id);
const failure = (repo) => readCatalog().failed.find((entry) => entry.sourceRepo === repo);
const served = (file) => fs.existsSync(path.join(dist, file));

async function main() {
  console.log(`Working in ${tmp}\n`);

  // ── first build ──
  push('static', { 'mastre.json': manifest('static-game'), 'index.html': page('static v1'), 'cover.png': 'png', '.env': 'SECRET=1' });
  const builtV1 = push('built', { 'mastre.json': manifest('built-game', { build: withBuild }), 'build.mjs': buildScript('built v1'), 'cover.png': 'png' });
  push('messy', {
    'mastre.json': manifest('messy-game', { output: '.' }),
    'index.html': page('<img src="/img/logo.png"><script>navigator.serviceWorker.register("sw.js"); localStorage.clear(); parent.postMessage({type:"mastre:ready"},"*")</script>'),
  });
  push('dupe', { 'mastre.json': manifest('static-game'), 'index.html': page('impostor') });
  push('slow', { 'mastre.json': manifest('slow-game', { build: { install: null, command: 'node -e "setTimeout(()=>{},60000)"', output: 'dist' } }) });
  push('nomanifest', { 'index.html': page('no manifest') });
  push('badid', { 'mastre.json': manifest('Bad Id'), 'index.html': page('x') });
  push('escape', { 'mastre.json': manifest('escape-game', { build: { install: null, command: null, output: '../../..' } }), 'index.html': page('x') });
  push('noentry', { 'mastre.json': manifest('noentry-game', { entry: 'missing.html' }), 'index.html': page('x') });

  fs.writeFileSync(registry, JSON.stringify([
    { repo: 'friend/static', ref: 'main' },
    { repo: 'friend/built', ref: 'main' },
    { repo: 'friend/messy' },
    { repo: 'friend/dupe', ref: 'main' },
    { repo: 'friend/slow', ref: 'main' },
    { repo: 'friend/nomanifest', ref: 'main' },
    { repo: 'friend/badid', ref: 'main' },
    { repo: 'friend/escape', ref: 'main' },
    { repo: 'friend/noentry', ref: 'main' },
    { repo: 'friend/ghost', ref: 'main' },
    { repo: 'not a repo' },
  ]));

  console.log('First build');
  const startedAt = Date.now();
  let result = await run();
  check('the pipeline exits 0 even though several games are broken', result.code === 0, result.out.slice(-600));
  check('a static game is built and served', game('static-game')?.stale === false && served('games/static-game/index.html'));
  check('a game with a build step is built and served', served('games/built-game/index.html') && game('built-game')?.sha === builtV1);
  check('the cover is published under covers/<id>', game('static-game')?.cover === 'covers/static-game.png' && served('covers/static-game.png'));
  check('tags are normalised to lowercase', game('static-game')?.tags[0] === 'test');
  check('hidden files are not published', !served('games/static-game/.env'));
  check('the catalog has sha, builtAt, stale and sourceRepo', ['sha', 'builtAt', 'stale', 'sourceRepo'].every((key) => key in (game('built-game') ?? {})));

  const messy = game('messy-game');
  const codes = (messy?.warnings ?? []).map((warning) => warning.code);
  check('absolute paths, a Service Worker and storage.clear() are warnings, not failures',
    ['absolute-path', 'service-worker', 'storage-clear'].every((code) => codes.includes(code)), codes.join(','));
  check('a missing cover is a warning and the game is still listed', codes.includes('cover-missing') && messy?.cover === null);
  check('the "mastre:ready" signal is detected', messy?.signals?.ready === true && game('static-game')?.signals?.ready === false);

  check('a duplicate id is refused and the first game keeps it',
    /already used/.test(failure('friend/dupe')?.error ?? '') && fs.readFileSync(path.join(dist, 'games/static-game/index.html'), 'utf8').includes('static v1'));
  check('a build over the time limit is stopped', /stopped/.test(failure('friend/slow')?.error ?? ''), failure('friend/slow')?.error);
  check('...and stopped promptly', Date.now() - startedAt < 60_000);
  check('a repo without mastre.json is left out with a reason', /not found at the root/.test(failure('friend/nomanifest')?.error ?? ''));
  check('an invalid id is left out with a reason', /lowercase letters/.test(failure('friend/badid')?.error ?? ''), failure('friend/badid')?.error);
  check('an output path that leaves the repo is refused', /relative to the repo root/.test(failure('friend/escape')?.error ?? ''), failure('friend/escape')?.error);
  check('a missing entry file is a failure', /missing\.html/.test(failure('friend/noentry')?.error ?? ''), failure('friend/noentry')?.error);
  check('a repo that does not exist is left out with a reason', Boolean(failure('friend/ghost')?.error), JSON.stringify(failure('friend/ghost')));
  check('a malformed registry entry is left out with a reason', /owner\/name/.test(readCatalog().failed.find((entry) => entry.sourceRepo === 'not a repo')?.error ?? ''));
  check('the summary table is printed', /built 3 · reused 0 · stale 0 · failed 8/.test(result.out), result.out.split('\n').slice(-4).join(' | '));

  const env = fs.readFileSync(path.join(dist, 'games/built-game/env.txt'), 'utf8');
  check('game builds see neither the read token nor other secrets',
    !/test-read-token|do-not-leak|MASTRE_READ_TOKEN|SUPER_SECRET|GITHUB_SHA/.test(env), env.split('\n').filter((line) => /TOKEN|SECRET|GITHUB/.test(line)).join(' '));

  // ── nothing changed ──
  console.log('\nSecond build, nothing changed');
  result = await run();
  check('unchanged games are reused, not rebuilt', /built 0 · reused 3 · stale 0 · failed 8/.test(result.out), result.out.split('\n').slice(-4).join(' | '));

  // ── a game breaks ──
  console.log('\nA game that worked now fails to build');
  const brokenSha = push('built', { 'build.mjs': 'process.exit(3);' });
  result = await run();
  check('the pipeline still exits 0', result.code === 0);
  check('the broken game is marked stale, with the error', game('built-game')?.stale === true && /exit code 3/.test(game('built-game')?.error ?? ''), game('built-game')?.error);
  check('...and keeps serving its last good build', game('built-game')?.sha === builtV1 && fs.readFileSync(path.join(dist, 'games/built-game/index.html'), 'utf8').includes('built v1'));
  check('...and records the commit that failed', game('built-game')?.attemptedSha === brokenSha);
  check('the other games are untouched', game('static-game')?.stale === false && /stale 1/.test(result.out));

  // ── the schedule: deploy only when something changed ──
  console.log('\nScheduled run against the deployed catalog');
  const { server, url } = await startStaticServer({ dir: dist, base: '/', port: 0 }).then(async (started) => ({
    server: started.server,
    url: `http://localhost:${started.server.address().port}/`,
  }));
  const planned = () => JSON.parse(fs.readFileSync(path.join(cache, 'plan.json'), 'utf8')).deploy;
  result = await run(['plan', '--if-changed'], { MASTRE_HUB_URL: url });
  check('nothing changed: the run stops before building', planned() === false && /Nothing changed/.test(result.out), result.out.slice(-300));
  result = await run(['plan', '--if-changed'], { MASTRE_HUB_URL: url, GITHUB_SHA: 'hubsha0002' });
  check('the hub changed: deploy', planned() === true && /hub itself changed/.test(result.out), result.out.slice(-300));

  // ── the game is fixed; this time through the CI steps, one at a time ──
  console.log('\nThe game is fixed (run as the separate CI steps)');
  const fixedSha = push('built', { 'build.mjs': buildScript('built v2') });
  result = await run(['plan', '--if-changed'], { MASTRE_HUB_URL: url });
  check('a game changed: deploy', planned() === true && /friend\/built moved to/.test(result.out), result.out.slice(-300));
  server.close();

  const plan = JSON.parse(fs.readFileSync(path.join(cache, 'plan.json'), 'utf8'));
  check('the plan does not contain the read token', !JSON.stringify(plan).includes('test-read-token'));
  fs.rmSync(path.join(cache, 'out', 'results'), { recursive: true, force: true });
  for (const entry of plan.entries.filter((candidate) => candidate.id)) {
    await run(['fetch', '--only', String(entry.n)]);
    // The build step runs without the token, as in the workflow.
    await run(['build', '--only', String(entry.n)], { MASTRE_READ_TOKEN: '' });
  }
  result = await run(['collect']);
  check('collect exits 0', result.code === 0, result.out.slice(-400));
  check('the fixed game is built again and no longer stale',
    game('built-game')?.stale === false && game('built-game')?.sha === fixedSha && fs.readFileSync(path.join(dist, 'games/built-game/index.html'), 'utf8').includes('built v2'));
  check('the rest is reused', /built 1 · reused 2 · stale 0 · failed 8/.test(result.out), result.out.split('\n').slice(-4).join(' | '));

  // ── a build job that never reports back ──
  console.log('\nA build job disappears');
  fs.rmSync(path.join(cache, 'out', 'results', '0.json'));
  result = await run(['collect']);
  check('collect refuses to deploy a site with a game missing', result.code === 1 && /did not report back/.test(result.out), result.out.slice(-300));

  // ── a repo vanishes ──
  console.log('\nA repo disappears');
  fs.rmSync(path.join(remotes, 'friend', 'static.git'), { recursive: true, force: true });
  result = await run();
  check('its last build stays up, marked stale', game('static-game')?.stale === true && served('games/static-game/index.html'), JSON.stringify(failure('friend/static')));
}

main()
  .catch((error) => {
    failures += 1;
    console.error(error);
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });

#!/usr/bin/env node
/**
 * Mastre Gaming build pipeline: turns games.json into dist/games, dist/covers
 * and dist/catalog.json.
 *
 *   node scripts/build-games.mjs            everything, in one go (local use)
 *   node scripts/build-games.mjs plan       resolve each game's commit and id
 *   node scripts/build-games.mjs fetch --only N    get the source of entry N
 *   node scripts/build-games.mjs build --only N    build entry N
 *   node scripts/build-games.mjs collect    assemble dist/ from what was built
 *
 * The split exists for CI, where every game builds on its own machine, the read
 * token is only present while fetching, and nothing secret is present while building.
 *
 * Options: --examples (also build examples/*), --registry <file>, --if-changed.
 *
 * A game that fails never fails this script. Its last good build is kept and
 * marked stale; if it never built, it is left out and the reason is reported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { copyTree, formatBytes, hashDir, moveDir, readJson, resolveInside, rmrf, writeJson } from './lib/fsx.mjs';
import { collectBuild, runBuild, skipHidden } from './lib/game.mjs';
import { cloneAt, commitDate, fetchManifestText, hubSha, resolveSha } from './lib/git.mjs';
import { c, endGroup, fail, group, info, ok, setOutput, shortError, stepSummary, table, warn } from './lib/log.mjs';
import { MANIFEST_NAME, ManifestError, peekId, readManifestText } from './lib/manifest.mjs';
import { CACHE, DIST, EXAMPLES, PLAN_FILE, RESULTS, ROOT, SCHEMA_FILE, SLOTS, SOURCES, STAGING } from './lib/paths.mjs';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const COVER_FILE_RE = /^cover\.(png|jpe?g|webp|avif|gif)$/;

/** On the schedule, a game whose build failed is tried again after this long. */
const RETRY_FAILED_MS = 6 * 60 * 60 * 1000;
/** On the schedule, deploy anyway after this long so the build caches (evicted after 7 idle days) stay alive. */
const KEEP_WARM_MS = 5 * 24 * 60 * 60 * 1000;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    examples: { type: 'boolean', default: false },
    registry: { type: 'string', default: 'games.json' },
    only: { type: 'string' },
    'if-changed': { type: 'boolean', default: false },
  },
});
const phase = positionals[0] ?? 'all';
const readToken = () => process.env.MASTRE_READ_TOKEN || null;

const resultFile = (n) => path.join(RESULTS, `${n}.json`);
const sourceDir = (entry) => path.join(SOURCES, String(entry.n));
const localDir = (entry) => resolveInside(ROOT, entry.path, 'games.json path');
const skipLocal = (_rel, dirent) => dirent.name === 'node_modules' || dirent.name === '.git';
const label = (entry) => entry.id ?? entry.sourceRepo;
const short = (sha) => (sha ? sha.slice(0, 7) : null);

// ───────────────────────────── registry ─────────────────────────────

function localEntry(relativePath) {
  const clean = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
  return { source: 'local', repo: null, ref: null, path: clean, sourceRepo: `local:${clean}` };
}

/** Reads games.json. A bad entry becomes an entry with an error, so it cannot stop the others. */
function readRegistry() {
  const file = path.resolve(ROOT, opts.registry);
  const list = readJson(file);
  if (!Array.isArray(list)) {
    throw new Error(`${opts.registry} must be a JSON array like [{ "repo": "owner/name", "ref": "main" }]`);
  }

  const entries = list.map((item) => {
    if (typeof item?.path === 'string') return localEntry(item.path);
    const repo = typeof item?.repo === 'string' ? item.repo.trim() : '';
    const ref = item?.ref == null || item.ref === '' ? null : String(item.ref).trim();
    const entry = { source: 'github', repo, ref, path: null, sourceRepo: repo || '(invalid entry)' };
    if (!REPO_RE.test(repo)) entry.error = `"repo" must look like "owner/name" (got ${JSON.stringify(item?.repo ?? null)})`;
    else if (ref && !REF_RE.test(ref)) entry.error = `"ref" ${JSON.stringify(ref)} is not a valid branch, tag or commit`;
    return entry;
  });

  if (opts.examples && fs.existsSync(EXAMPLES)) {
    for (const dirent of fs.readdirSync(EXAMPLES, { withFileTypes: true })) {
      if (dirent.isDirectory() && fs.existsSync(path.join(EXAMPLES, dirent.name, MANIFEST_NAME))) {
        entries.push(localEntry(`examples/${dirent.name}`));
      }
    }
  }

  return entries.map((entry, n) => ({ n, sha: null, id: null, auth: false, error: null, ...entry }));
}

// ───────────────────────────── plan ─────────────────────────────

function hubUrl() {
  if (process.env.MASTRE_HUB_URL) return process.env.MASTRE_HUB_URL.replace(/\/*$/, '/');
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? '').toLowerCase().split('/');
  if (!owner || !name) return null;
  return name === `${owner}.github.io` ? `https://${name}/` : `https://${owner}.github.io/${name}/`;
}

/** The catalog of the site that is live right now, or null (first deploy, offline, local run). */
async function fetchDeployedCatalog() {
  const url = hubUrl();
  if (!url) return null;
  try {
    const response = await fetch(`${url}catalog.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const catalog = await response.json();
    return Array.isArray(catalog?.games) ? catalog : null;
  } catch {
    return null;
  }
}

/** Why a deploy is needed, or null when the live site is already up to date. */
function whyDeploy(entries, deployed, currentHubSha) {
  if (!deployed) return 'no deployed catalog was found';
  if (!currentHubSha || deployed.hub?.sha !== currentHubSha) return 'the hub itself changed';

  const now = Date.now();
  if (now - Date.parse(deployed.generatedAt) > KEEP_WARM_MS) return 'refreshing the build caches';

  const key = (repo, ref) => `${repo}@${ref ?? 'HEAD'}`;
  const live = new Map();
  for (const game of deployed.games) {
    live.set(key(game.sourceRepo, game.sourceRef), {
      sha: game.attemptedSha === undefined ? game.sha : game.attemptedSha,
      healthy: !game.stale,
      at: game.attemptedAt ?? game.builtAt,
    });
  }
  for (const failure of deployed.failed ?? []) {
    live.set(key(failure.sourceRepo, failure.sourceRef), { sha: failure.sha, healthy: false, at: failure.attemptedAt });
  }

  for (const entry of entries) {
    const state = live.get(key(entry.sourceRepo, entry.ref));
    if (!state) return `${entry.sourceRepo} is new`;
    // Cannot be reached right now but the live build is fine: leave it alone.
    if (!entry.sha && state.healthy) continue;
    if (entry.sha && entry.sha !== state.sha) return `${entry.sourceRepo} moved to ${short(entry.sha)}`;
    if (!state.healthy && now - Date.parse(state.at) > RETRY_FAILED_MS) return `trying ${entry.sourceRepo} again`;
  }
  return null;
}

/** Ids we have seen before, so a game that cannot be reached today can still show its last build. */
function knownIds(deployed) {
  const known = new Map();
  for (const game of deployed?.games ?? []) known.set(game.sourceRepo, game.id);
  if (fs.existsSync(SLOTS)) {
    for (const dirent of fs.readdirSync(SLOTS, { withFileTypes: true })) {
      try {
        const meta = readJson(path.join(SLOTS, dirent.name, 'meta.json'));
        if (meta.id === dirent.name) known.set(meta.sourceRepo, meta.id);
      } catch { /* not a finished slot */ }
    }
  }
  return known;
}

function manifestTextOf(entry, token) {
  if (entry.source === 'local') {
    const file = path.join(localDir(entry), MANIFEST_NAME);
    if (!fs.existsSync(file)) throw new ManifestError([`not found in ${entry.path}`]);
    return fs.readFileSync(file, 'utf8');
  }
  return fetchManifestText(entry.repo, entry.sha, entry.auth ? token : null, path.join(CACHE, 'peek', String(entry.n)));
}

async function makePlan() {
  const entries = readRegistry();
  const token = readToken();

  group('Resolving game versions');
  for (const entry of entries) {
    try {
      if (entry.error) throw new Error(entry.error);
      if (entry.source === 'local') entry.sha = hashDir(localDir(entry), { skip: skipLocal });
      else Object.assign(entry, resolveSha(entry.repo, entry.ref, token));
      info(`  ${entry.sourceRepo}${entry.ref ? ` @ ${entry.ref}` : ''} → ${short(entry.sha)}`);
    } catch (error) {
      entry.error = shortError(error);
      fail(`${entry.sourceRepo}: ${entry.error}`);
    }
  }
  if (!entries.length) info('  games.json is empty.');
  endGroup();

  const hub = { repo: process.env.GITHUB_REPOSITORY || null, sha: hubSha(ROOT) };
  const deployed = await fetchDeployedCatalog();

  if (opts['if-changed'] || process.env.MASTRE_IF_CHANGED === '1') {
    const reason = whyDeploy(entries, deployed, hub.sha);
    if (!reason) {
      info('Nothing changed since the last deploy. Stopping here.');
      writeJson(PLAN_FILE, { generatedAt: new Date().toISOString(), hub, deploy: false, entries: [] });
      setOutput('deploy', 'false');
      setOutput('count', '0');
      setOutput('matrix', '[]');
      return null;
    }
    info(`Deploying because ${reason}.`);
  }

  // Each game's id comes from its own mastre.json, so the manifest is read before anything is built.
  const known = knownIds(deployed);
  for (const entry of entries) {
    if (!entry.error) {
      try {
        entry.id = peekId(readManifestText(manifestTextOf(entry, token)));
      } catch (error) {
        entry.error = shortError(error);
        fail(`${entry.sourceRepo}: ${entry.error}`);
      }
    }
    if (!entry.id) entry.id = known.get(entry.sourceRepo) ?? null;
  }

  // The first entry in games.json to claim an id keeps it.
  const owners = new Map();
  for (const entry of entries) {
    if (!entry.id) continue;
    if (owners.has(entry.id)) {
      entry.error = `id "${entry.id}" is already used by ${owners.get(entry.id)}; ids must be unique across the hub`;
      entry.id = null;
      fail(`${entry.sourceRepo}: ${entry.error}`);
    } else {
      owners.set(entry.id, entry.sourceRepo);
    }
  }

  const plan = { generatedAt: new Date().toISOString(), hub, deploy: true, entries };
  writeJson(PLAN_FILE, plan);

  const matrix = entries.filter((entry) => entry.id).map((entry) => ({ n: entry.n, id: entry.id, sha: entry.sha ?? 'unresolved' }));
  setOutput('deploy', 'true');
  setOutput('count', String(matrix.length));
  setOutput('matrix', JSON.stringify(matrix));
  return plan;
}

// ───────────────────────────── one game ─────────────────────────────

/** The last successful build of this entry's game, or null. */
function readSlot(entry) {
  if (!entry.id) return null;
  const dir = path.join(SLOTS, entry.id);
  try {
    const meta = readJson(path.join(dir, 'meta.json'));
    if (meta.id !== entry.id || meta.sourceRepo !== entry.sourceRepo) return null;
    if (!fs.existsSync(path.join(dir, 'build', meta.entry))) return null;
    return { dir, meta };
  } catch {
    return null;
  }
}

function settle(entry, status, error = null, extra = {}) {
  const result = {
    n: entry.n,
    id: entry.id,
    sourceRepo: entry.sourceRepo,
    sha: entry.sha,
    status,
    error,
    attemptedAt: new Date().toISOString(),
    ...extra,
  };
  writeJson(resultFile(entry.n), result);
  return result;
}

/** A failure costs the game its update, not its place on the hub: fall back to the last good build. */
function settleFailure(entry, error) {
  const message = shortError(error);
  const slot = readSlot(entry);
  if (slot) {
    warn(`${label(entry)}: ${message}`);
    info(`  Keeping the last good build (${short(slot.meta.sha)}) and marking it stale.`);
    return settle(entry, 'stale', message);
  }
  fail(`${label(entry)}: ${message}`);
  info('  There is no earlier build to fall back on, so this game is left out.');
  return settle(entry, 'failed', message);
}

/** Returns a final result when there is nothing to build, or null when the source is ready to build. */
function fetchSource(entry, token) {
  if (entry.error) return settleFailure(entry, entry.error);

  const slot = readSlot(entry);
  if (slot && slot.meta.sha === entry.sha) {
    ok(`${entry.id}: ${short(entry.sha)} is already built, reusing it`);
    return settle(entry, 'reused');
  }

  const dir = sourceDir(entry);
  try {
    if (entry.source === 'local') {
      rmrf(dir);
      copyTree(localDir(entry), dir, { skip: skipLocal });
    } else {
      cloneAt(entry.repo, entry.sha, dir, entry.auth ? token : null);
    }
  } catch (error) {
    return settleFailure(entry, `could not fetch the source: ${shortError(error)}`);
  }

  // If the build step is killed before it can report, this is what the collect step finds.
  settle(entry, slot ? 'stale' : 'failed', 'the build did not finish (it was stopped or it crashed)', { pending: true });
  return null;
}

async function buildGame(entry) {
  const dir = sourceDir(entry);
  const stage = path.join(STAGING, entry.id);
  try {
    if (!fs.existsSync(dir)) throw new Error('the source was not fetched');
    const { manifest, outDir, warnings: manifestWarnings } = await runBuild(dir, { expectedId: entry.id });
    const collected = collectBuild({ srcDir: dir, outDir, manifest, dest: stage });
    const warnings = [...manifestWarnings, ...collected.warnings];
    const now = new Date().toISOString();

    writeJson(path.join(stage, 'meta.json'), {
      ...manifest,
      cover: null,
      coverFile: collected.coverFile,
      sha: entry.sha,
      builtAt: now,
      updatedAt: commitDate(dir) ?? now,
      sourceRepo: entry.sourceRepo,
      sourceRef: entry.ref,
      sizeBytes: collected.sizeBytes,
      fileCount: collected.fileCount,
      signals: collected.signals,
      warnings,
    });
    moveDir(stage, path.join(SLOTS, entry.id));

    for (const warning of warnings) warn(`${entry.id}: ${warning.message}`);
    ok(`${entry.id}: built ${short(entry.sha)} (${collected.fileCount} files, ${formatBytes(collected.sizeBytes)})`);
    return settle(entry, 'built');
  } catch (error) {
    rmrf(stage);
    if (error instanceof ManifestError) for (const problem of error.problems) info(`  - ${problem}`);
    return settleFailure(entry, error);
  }
}

// ───────────────────────────── collect ─────────────────────────────

function collect(plan) {
  const gamesOut = path.join(DIST, 'games');
  const coversOut = path.join(DIST, 'covers');
  rmrf(gamesOut);
  rmrf(coversOut);
  fs.mkdirSync(gamesOut, { recursive: true });
  fs.mkdirSync(coversOut, { recursive: true });

  const catalog = { schemaVersion: 1, generatedAt: new Date().toISOString(), hub: plan.hub, games: [], failed: [] };
  const rows = [];

  for (const entry of plan.entries) {
    let result;
    if (!entry.id) {
      result = { status: 'failed', error: entry.error ?? 'unknown error', attemptedAt: plan.generatedAt };
    } else if (!fs.existsSync(resultFile(entry.n))) {
      // Not the game's fault: the pipeline lost track of it. Deploying now would drop a working game.
      throw new Error(`No build result for ${entry.sourceRepo}. A build job did not report back, so nothing is deployed.`);
    } else {
      result = readJson(resultFile(entry.n));
    }

    const slot = result.status === 'failed' ? null : readSlot(entry);
    if (result.status !== 'failed' && !slot) {
      result = { ...result, status: 'failed', error: result.error ?? 'the build that was expected in the cache is missing' };
    }

    if (!slot) {
      catalog.failed.push({
        sourceRepo: entry.sourceRepo,
        sourceRef: entry.ref,
        id: entry.id,
        sha: entry.sha,
        error: result.error,
        attemptedAt: result.attemptedAt,
      });
      rows.push({ game: entry.id, status: 'failed', sha: short(entry.sha), source: entry.sourceRepo, notes: result.error });
      continue;
    }

    // Paths are rebuilt from the id here; nothing a build wrote is trusted to say where files go.
    const { coverFile, ...meta } = slot.meta;
    copyTree(path.join(slot.dir, 'build'), path.join(gamesOut, entry.id), { skip: skipHidden });
    let cover = null;
    if (typeof coverFile === 'string' && COVER_FILE_RE.test(coverFile) && fs.existsSync(path.join(slot.dir, coverFile))) {
      cover = `covers/${entry.id}${path.extname(coverFile)}`;
      fs.copyFileSync(path.join(slot.dir, coverFile), path.join(DIST, cover));
    }

    const stale = result.status === 'stale';
    catalog.games.push({
      ...meta,
      id: entry.id,
      cover,
      path: `games/${entry.id}/`,
      stale,
      error: stale ? result.error : null,
      attemptedSha: entry.sha,
      attemptedAt: result.attemptedAt,
    });

    const warnings = meta.warnings?.length ?? 0;
    rows.push({
      game: entry.id,
      status: result.status,
      sha: short(meta.sha),
      size: formatBytes(meta.sizeBytes),
      source: entry.sourceRepo,
      notes: stale ? result.error : warnings ? `${warnings} warning${warnings > 1 ? 's' : ''}` : '',
    });
  }

  writeJson(path.join(DIST, 'catalog.json'), catalog);
  fs.mkdirSync(path.join(DIST, 'schema'), { recursive: true });
  fs.copyFileSync(SCHEMA_FILE, path.join(DIST, 'schema', 'mastre.schema.json'));

  summarise(rows);
}

function summarise(rows) {
  const count = (status) => rows.filter((row) => row.status === status).length;
  const totals = `built ${count('built')} · reused ${count('reused')} · stale ${count('stale')} · failed ${count('failed')}`;
  const columns = [['game', 'GAME'], ['status', 'STATUS'], ['sha', 'COMMIT'], ['size', 'SIZE'], ['source', 'SOURCE'], ['notes', 'NOTES']];

  console.log(`\n${c.bold('Mastre Gaming build summary')}\n`);
  console.log(rows.length ? table(rows, columns) : '  No games in the registry yet.');
  console.log(`\n  ${c.bold(totals)}\n`);

  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|') || '-';
  stepSummary([
    '### Mastre Gaming build',
    '',
    `| ${columns.map(([, heading]) => heading).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map(([key]) => cell(row[key])).join(' | ')} |`),
    '',
    `**${totals}**`,
  ].join('\n'));
}

// ───────────────────────────── main ─────────────────────────────

function readPlan() {
  if (!fs.existsSync(PLAN_FILE)) throw new Error('No plan found. Run the "plan" step first.');
  return readJson(PLAN_FILE);
}

function pickEntry(plan) {
  const entry = plan.entries.find((candidate) => String(candidate.n) === String(opts.only));
  if (!entry) throw new Error(`--only ${opts.only}: there is no such entry in the plan`);
  return entry;
}

async function main() {
  if (phase === 'plan') {
    await makePlan();
  } else if (phase === 'fetch') {
    const result = fetchSource(pickEntry(readPlan()), readToken());
    setOutput('status', result?.status ?? 'pending');
  } else if (phase === 'build') {
    const entry = pickEntry(readPlan());
    const earlier = fs.existsSync(resultFile(entry.n)) ? readJson(resultFile(entry.n)) : null;
    const result = earlier && !earlier.pending ? earlier : await buildGame(entry);
    if (result === earlier) info(`${label(entry)}: nothing to build (${earlier.status}).`);
    setOutput('status', result.status);
  } else if (phase === 'collect') {
    collect(readPlan());
  } else if (phase === 'all') {
    rmrf(RESULTS);
    rmrf(SOURCES);
    const plan = await makePlan();
    if (!plan) return;
    for (const entry of plan.entries.filter((candidate) => candidate.id)) {
      group(`Game: ${entry.id}  (${entry.sourceRepo})`);
      const result = fetchSource(entry, readToken()) ?? (await buildGame(entry));
      if (result.status === 'built') rmrf(sourceDir(entry));
      endGroup();
    }
    collect(plan);
  } else {
    throw new Error(`Unknown step "${phase}". Use plan, fetch, build, collect, or nothing at all.`);
  }
}

main().catch((error) => {
  console.error(`\n${c.red('Pipeline error:')} ${error.message}`);
  process.exit(1);
});

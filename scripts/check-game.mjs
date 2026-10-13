#!/usr/bin/env node
/**
 * Checks one game folder the way the hub will, then serves it inside the real
 * launcher so it can be played before it is submitted.
 *
 *   npm run check-game -- ../my-game
 *
 * Options: --no-build (use the output that is already there), --no-serve
 * (report and exit), --port <number> (default 4390).
 *
 * The build runs in the game's own folder, with the same clean environment and
 * the same time limit as on the hub.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatBytes, moveDir, rmrf, writeJson } from './lib/fsx.mjs';
import { collectBuild, runBuild } from './lib/game.mjs';
import { c, fail, info, ok, warn } from './lib/log.mjs';
import { MANIFEST_NAME, ManifestError } from './lib/manifest.mjs';
import { CACHE, ROOT } from './lib/paths.mjs';
import { MAX_BUILD_BYTES } from './lib/scan.mjs';
import { startStaticServer } from './lib/static.mjs';

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'no-build': { type: 'boolean', default: false },
    'no-serve': { type: 'boolean', default: false },
    port: { type: 'string', default: '4390' },
  },
});

if (!positionals[0]) {
  console.error('Usage: npm run check-game -- <path to the game folder>');
  process.exit(1);
}

// `npm run` moves into the hub folder; the path is relative to where the command was typed.
const gameDir = path.resolve(process.env.INIT_CWD ?? process.cwd(), positionals[0]);
const site = path.join(CACHE, 'check', 'site');
const stage = path.join(CACHE, 'check', 'stage');

/** Passing checks, so the report says what was looked at, not only what went wrong. */
const CHECKS = [
  ['absolute-path', 'No absolute "/" paths in HTML, CSS or JS'],
  ['service-worker', 'No Service Worker'],
  ['storage-clear', 'Does not clear all of localStorage/sessionStorage'],
  ['too-large', `Build is under ${formatBytes(MAX_BUILD_BYTES)}`],
  ['large-file', 'No single file over 50 MB'],
  ['cover-missing', 'Cover image found'],
  ['cover-large', 'Cover is under 500 KB'],
  ['links-skipped', 'No symlinks in the build'],
];

async function buildLauncher(manifest) {
  try {
    const { build } = await import('vite');
    await build({ configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn', build: { outDir: site, emptyOutDir: false } });
    return true;
  } catch (error) {
    // Without the launcher (dev dependencies not installed), fall back to a bare frame.
    warn(`Could not build the launcher (${error.message.split('\n')[0]}). Using a plain test page instead.`);
    const page = `<!doctype html><meta charset="utf-8"><title>${manifest.id}</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style>
<iframe src="games/${manifest.id}/${manifest.entry}" allow="fullscreen; gamepad; autoplay; clipboard-write"></iframe>`;
    fs.writeFileSync(path.join(site, 'index.html'), page);
    fs.writeFileSync(path.join(site, 'play.html'), page);
    return false;
  }
}

async function main() {
  console.log(`\n${c.bold('Checking')} ${gameDir}\n`);
  if (!fs.existsSync(path.join(gameDir, MANIFEST_NAME))) {
    fail(`${MANIFEST_NAME} not found in ${gameDir}`);
    return 1;
  }

  // 1. Manifest, build, entry.
  let built;
  const started = Date.now();
  try {
    built = await runBuild(gameDir, { skipCommands: opts['no-build'] });
  } catch (error) {
    if (error instanceof ManifestError) {
      fail(`${MANIFEST_NAME} is not valid:`);
      for (const problem of error.problems) info(`    - ${problem}`);
    } else {
      fail(error.message);
    }
    console.log(`\n${c.red('Not ready.')} Fix the problem above and run the check again.\n`);
    return 1;
  }
  const { manifest, outputDir, outDir } = built;
  ok(`${MANIFEST_NAME} is valid (id "${manifest.id}", version ${manifest.version})`);
  if (manifest.build && !opts['no-build']) ok(`Install and build finished in ${Math.round((Date.now() - started) / 1000)} s`);
  ok(`Entry found: ${outputDir === '.' ? '' : `${outputDir}/`}${manifest.entry}`);

  // 2. Copy it exactly as the hub would, and scan it.
  rmrf(site);
  let collected;
  try {
    collected = collectBuild({ srcDir: gameDir, outDir, manifest, dest: stage });
  } catch (error) {
    fail(error.message);
    return 1;
  }
  const warnings = [...built.warnings, ...collected.warnings];
  const raised = new Set(warnings.map((warning) => warning.code));
  for (const [code, text] of CHECKS) if (!raised.has(code)) ok(text);
  for (const warning of warnings) warn(warning.message);

  info(`\n  ${collected.fileCount} files, ${formatBytes(collected.sizeBytes)}`);
  info(`  Sends "mastre:ready": ${collected.signals.ready ? 'yes' : 'no (optional: the loading screen then leaves when the page has loaded)'}`);
  info(`  Sends "mastre:exit":  ${collected.signals.exit ? 'yes' : 'no (optional: lets a Quit button return to the hub)'}`);
  info(`  Not checked here: storage keys must start with "mastre:${manifest.id}:"`);

  const verdict = warnings.length
    ? c.yellow(`Built, with ${warnings.length} warning${warnings.length > 1 ? 's' : ''} to fix before submitting.`)
    : c.green('Ready to submit.');
  console.log(`\n${verdict}\n`);
  if (opts['no-serve']) return 0;

  // 3. A one-game copy of the hub, under a subpath like the real one.
  moveDir(path.join(stage, 'build'), path.join(site, 'games', manifest.id));
  let cover = null;
  if (collected.coverFile) {
    cover = `covers/${manifest.id}${path.extname(collected.coverFile)}`;
    fs.mkdirSync(path.join(site, 'covers'), { recursive: true });
    fs.copyFileSync(path.join(stage, collected.coverFile), path.join(site, cover));
  }
  const now = new Date().toISOString();
  writeJson(path.join(site, 'catalog.json'), {
    schemaVersion: 1,
    generatedAt: now,
    hub: { repo: null, sha: null },
    games: [{
      ...manifest, cover, path: `games/${manifest.id}/`, sha: 'local-check', builtAt: now, updatedAt: now,
      stale: false, error: null, sourceRepo: 'local', signals: collected.signals,
    }],
    failed: [],
  });
  rmrf(stage);
  const hasLauncher = await buildLauncher(manifest);

  const { url } = await startStaticServer({
    dir: site,
    base: '/mastre-gaming/',
    port: Number(opts.port),
    onRequest: ({ url: requested, status }) => {
      // Browsers ask for /favicon.ico on their own; it says nothing about the game.
      if (status === 404 && requested !== '/favicon.ico') console.log(`${c.red('404')} ${requested}${requested.startsWith('/mastre-gaming/') ? '' : c.dim('   ← an absolute path? It must be relative.')}`);
    },
  });
  console.log(`  Play it in the hub:  ${c.cyan(`${url}${hasLauncher ? `play.html?id=${manifest.id}` : ''}`)}`);
  console.log(`  The game on its own: ${c.cyan(`${url}games/${manifest.id}/${manifest.entry === 'index.html' ? '' : manifest.entry}`)}`);
  console.log(c.dim('\n  Requests that fail are listed below. Ctrl+C to stop.\n'));
  return null;
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (error) => {
    console.error(`\n${c.red('check-game failed:')} ${error.message}`);
    process.exit(1);
  },
);

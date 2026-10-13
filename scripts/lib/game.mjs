import fs from 'node:fs';
import path from 'node:path';
import { copyTree, formatBytes, resolveInside, rmrf } from './fsx.mjs';
import { loadManifest } from './manifest.mjs';
import { cleanEnv, runCommand } from './run.mjs';
import { MAX_COVER_BYTES, scanBuild } from './scan.mjs';

/** Install and build together get this long. The env override exists for the tests. */
export const BUILD_LIMIT_MS = Number(process.env.MASTRE_BUILD_TIMEOUT_MS) || 10 * 60 * 1000;

/** Files and folders starting with a dot are never published (.git, .env, .github, ...). */
export const skipHidden = (_rel, entry) => entry.name.startsWith('.');

const limitText = () => {
  const minutes = BUILD_LIMIT_MS / 60000;
  return minutes >= 1 ? `${minutes} minutes` : `${BUILD_LIMIT_MS / 1000} seconds`;
};

/**
 * Validates mastre.json, runs the game's own install and build commands inside
 * `srcDir`, and checks that the entry file came out.
 * Returns { manifest, outputDir, outDir, warnings }. Throws with a readable message otherwise.
 */
export async function runBuild(srcDir, { expectedId = null, skipCommands = false } = {}) {
  const { manifest, outputDir, warnings } = await loadManifest(srcDir);
  if (expectedId && manifest.id !== expectedId) {
    throw new Error(`mastre.json has id "${manifest.id}" but "${expectedId}" was expected`);
  }

  if (manifest.build && !skipCommands) {
    const deadline = Date.now() + BUILD_LIMIT_MS;
    const env = cleanEnv({ MASTRE_GAME_ID: manifest.id });
    for (const [step, command] of [['install', manifest.build.install], ['build', manifest.build.command]]) {
      if (!command) continue;
      const result = await runCommand(command, { cwd: srcDir, env, timeoutMs: deadline - Date.now() });
      if (result.timedOut) throw new Error(`the ${step} step was stopped: install and build took longer than ${limitText()}`);
      if (result.code !== 0) throw new Error(`the ${step} step failed (exit code ${result.code}): ${command}`);
    }
  }

  const outDir = resolveInside(srcDir, outputDir, 'build output');
  if (!fs.statSync(outDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`the output folder "${outputDir}" does not exist${manifest.build ? ' after the build' : ''}`);
  }
  const entryFile = resolveInside(outDir, manifest.entry, 'entry');
  if (!fs.statSync(entryFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`entry "${manifest.entry}" was not found in the output folder "${outputDir}"`);
  }
  const found = warnings.map((message) => ({ code: 'manifest', message }));
  const attributes = path.join(srcDir, '.gitattributes');
  if (fs.existsSync(attributes) && fs.readFileSync(attributes, 'utf8').includes('filter=lfs')) {
    found.push({ code: 'git-lfs', message: 'this repo uses Git LFS, which the hub does not download: those files will be missing from the build' });
  }
  return { manifest, outputDir, outDir, warnings: found };
}

/**
 * Copies a finished build to `dest/build` and its cover to `dest/cover.<ext>`, then
 * scans what was copied. Returns { coverFile, sizeBytes, fileCount, signals, warnings }.
 */
export function collectBuild({ srcDir, outDir, manifest, dest }) {
  rmrf(dest);
  const buildDir = path.join(dest, 'build');
  const copied = copyTree(outDir, buildDir, { skip: skipHidden });
  if (!fs.existsSync(path.join(buildDir, manifest.entry))) {
    throw new Error(`entry "${manifest.entry}" is hidden or a link, so it cannot be published`);
  }

  const warnings = [];
  if (copied.leftOut.length) {
    warnings.push({
      code: 'links-skipped',
      message: `${copied.leftOut.length} symlinks or special files were not published (first: ${copied.leftOut[0]})`,
    });
  }

  let coverFile = null;
  try {
    const coverSource = resolveInside(srcDir, manifest.cover, 'cover');
    const stat = fs.lstatSync(coverSource, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      warnings.push({ code: 'cover-missing', message: `cover "${manifest.cover}" was not found; the launcher shows a placeholder` });
    } else {
      coverFile = `cover${path.extname(manifest.cover).toLowerCase()}`;
      fs.copyFileSync(coverSource, path.join(dest, coverFile));
      if (stat.size > MAX_COVER_BYTES) {
        warnings.push({ code: 'cover-large', message: `cover is ${formatBytes(stat.size)}; keep it under ${formatBytes(MAX_COVER_BYTES)}` });
      }
    }
  } catch (error) {
    warnings.push({ code: 'cover-missing', message: error.message });
  }

  const scan = scanBuild(buildDir);
  return { coverFile, ...scan, warnings: [...warnings, ...scan.warnings] };
}

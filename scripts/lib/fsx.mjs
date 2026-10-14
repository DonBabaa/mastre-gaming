import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

/** Reads a JSON file. A leading byte-order mark (Windows editors add one) is ignored. */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** True when `target` is `base` or sits inside it. */
export function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves a path taken from a manifest and refuses anything that leaves `base`,
 * either directly ("../x") or through a symlink.
 */
export function resolveInside(base, relative, label) {
  const target = path.resolve(base, relative);
  if (!isInside(base, target)) throw new Error(`${label} "${relative}" points outside the game folder`);
  if (fs.existsSync(target) && !isInside(fs.realpathSync(base), fs.realpathSync(target))) {
    throw new Error(`${label} "${relative}" is a link to somewhere outside the game folder`);
  }
  return target;
}

/** Every regular file under `dir`, as { rel, abs, size }. Symlinks are not followed. */
export function* walkFiles(dir, { skip = () => false } = {}, rel = '') {
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip(childRel, entry)) continue;
    if (entry.isDirectory()) yield* walkFiles(dir, { skip }, childRel);
    else if (entry.isFile()) {
      const abs = path.join(dir, childRel);
      yield { rel: childRel, abs, size: fs.statSync(abs).size };
    }
  }
}

/**
 * Copies regular files and folders only. Symlinks and special files are left out
 * and reported, so a build can never publish something that lives outside its own folder.
 */
export function copyTree(src, dst, { skip = () => false } = {}) {
  const stats = { files: 0, bytes: 0, leftOut: [] };
  const walk = (rel) => {
    fs.mkdirSync(path.join(dst, rel), { recursive: true });
    for (const entry of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(childRel, entry)) continue;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) {
        fs.copyFileSync(path.join(src, childRel), path.join(dst, childRel));
        stats.files += 1;
        stats.bytes += fs.statSync(path.join(dst, childRel)).size;
      } else stats.leftOut.push(childRel);
    }
  };
  walk('');
  return stats;
}

/** Moves a folder into place, replacing what was there. Retries because Windows locks files briefly. */
export function moveDir(from, to) {
  rmrf(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) {
        copyTree(from, to);
        rmrf(from);
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

/** Stable fingerprint of a folder's contents, used as the "commit" of a local game. */
export function hashDir(dir, { skip = () => false } = {}) {
  const hash = crypto.createHash('sha1');
  for (const file of walkFiles(dir, { skip })) {
    hash.update(`${file.rel}\0${file.size}\0`);
    hash.update(fs.readFileSync(file.abs));
  }
  return hash.digest('hex');
}

export function formatBytes(bytes) {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

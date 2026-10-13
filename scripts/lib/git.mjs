import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rmrf } from './fsx.mjs';
import { MANIFEST_NAME, ManifestError } from './manifest.mjs';

const SHA_RE = /^[0-9a-f]{40}$/;
const LOOKS_PRIVATE = /not found|could not read Username|Authentication failed|terminal prompts disabled|403|401/i;

/** MASTRE_GIT_BASE lets the tests point "owner/name" at local bare repos. */
export function repoUrl(repo) {
  return `${process.env.MASTRE_GIT_BASE || 'https://github.com/'}${repo}.git`;
}

/**
 * The read token is handed to git through its environment only: it never appears
 * in a command line, and it is never written into a clone's config where a game's
 * build step could find it.
 */
function gitEnv(token) {
  // Git LFS files are not downloaded, on every machine alike: a game must build from a plain clone.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' };
  delete env.MASTRE_READ_TOKEN;
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

function git(args, { cwd, token, timeout = 120_000 } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      env: gitEnv(token),
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.signal) throw new Error(`git ${args[0]} timed out`);
    const lines = String(error.stderr ?? error.message).split('\n').map((line) => line.trim()).filter(Boolean);
    const line = lines.findLast((text) => /^(fatal|error|remote):/i.test(text)) ?? lines.at(-1) ?? 'git failed';
    throw new Error(line.replace(/^(fatal|error):\s*/i, ''));
  }
}

function listRemote(repo, ref, token) {
  const patterns = !ref
    ? ['HEAD']
    : ref.startsWith('refs/')
      ? [ref]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  const output = git(['ls-remote', repoUrl(repo), ...patterns], { token, timeout: 60_000 });
  const refs = new Map(output.split('\n').filter(Boolean).map((line) => line.split('\t').reverse()));
  const sha = !ref
    ? refs.get('HEAD')
    : refs.get(ref) ?? refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
  if (!sha) throw new Error(ref ? `branch or tag "${ref}" was not found in ${repo}` : `${repo} has no commits yet`);
  return sha;
}

/**
 * Latest commit of `ref` (a branch, a tag, a full commit sha, or nothing for the default branch).
 * Public repos are read without the token; the token is only tried when that fails.
 * Returns { sha, auth } where `auth` says whether the token was needed.
 */
export function resolveSha(repo, ref, token) {
  if (ref && SHA_RE.test(ref)) return { sha: ref, auth: false };
  try {
    return { sha: listRemote(repo, ref, null), auth: false };
  } catch (error) {
    if (!LOOKS_PRIVATE.test(error.message)) throw error;
    if (!token) throw new Error(`${repo} was not found, or is private and MASTRE_READ_TOKEN is not set`);
    try {
      return { sha: listRemote(repo, ref, token), auth: true };
    } catch (second) {
      if (!LOOKS_PRIVATE.test(second.message)) throw second;
      throw new Error(`${repo} was not found, or MASTRE_READ_TOKEN cannot read it`);
    }
  }
}

function fetchCommit(dir, sha, token, extra = []) {
  git(['fetch', '-q', '--depth', '1', ...extra, 'origin', sha], { cwd: dir, token, timeout: 300_000 });
}

/** Reads mastre.json at one commit without downloading the rest of the repo. */
export function fetchManifestText(repo, sha, token, scratch) {
  rmrf(scratch);
  fs.mkdirSync(scratch, { recursive: true });
  try {
    git(['init', '-q', '--bare'], { cwd: scratch });
    git(['remote', 'add', 'origin', repoUrl(repo)], { cwd: scratch });
    try {
      fetchCommit(scratch, sha, token, ['--filter=blob:none']);
    } catch {
      fetchCommit(scratch, sha, token);
    }
    try {
      return git(['show', `${sha}:${MANIFEST_NAME}`], { cwd: scratch, token });
    } catch (error) {
      if (/does not exist|exists on disk, but not in/i.test(error.message)) {
        throw new ManifestError(['not found at the root of the repo']);
      }
      throw error;
    }
  } finally {
    rmrf(scratch);
  }
}

/** Shallow checkout of exactly one commit. Submodules are not fetched. */
export function cloneAt(repo, sha, dir, token) {
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q'], { cwd: dir });
  git(['remote', 'add', 'origin', repoUrl(repo)], { cwd: dir });
  fetchCommit(dir, sha, token);
  git(['-c', 'advice.detachedHead=false', '-c', 'core.longpaths=true', 'checkout', '-q', '--detach', 'FETCH_HEAD'], {
    cwd: dir,
    token,
    timeout: 300_000,
  });
}

/** Commit date of a clone made by cloneAt, or null for a folder that is not one. */
export function commitDate(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    return git(['log', '-1', '--format=%cI'], { cwd: dir }).trim() || null;
  } catch {
    return null;
  }
}

/** Commit of the hub itself, used to tell whether the hub changed since the last deploy. */
export function hubSha(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return git(['rev-parse', 'HEAD'], { cwd: root }).trim() || null;
  } catch {
    return null;
  }
}

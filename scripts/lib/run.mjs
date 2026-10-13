import { spawn, spawnSync } from 'node:child_process';
import { c } from './log.mjs';

/**
 * Game build steps are code we did not write. They get a small, fixed environment:
 * what a shell and npm need to work, and nothing else. Secrets, tokens and the
 * GitHub Actions variables of the hub's own workflow are never passed down.
 */
const PASS_THROUGH = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  // Windows needs these to start a shell and for npm to find its folders.
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
]);

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PASS_THROUGH.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, CI: 'true', MASTRE: '1', ...extra };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Runs one shell command, echoing its output indented. Kills the whole process
 * tree when the time limit is reached. Resolves with { code, timedOut, tail }
 * where `tail` is the last lines of output, for the error report.
 */
export function runCommand(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    console.log(c.dim(`  $ ${command}`));
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    const tail = [];
    let pending = '';
    const onData = (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        console.log(c.dim(`  │ ${line}`));
        tail.push(line);
        if (tail.length > 25) tail.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));

    const finish = (code) => {
      clearTimeout(timer);
      if (pending) {
        console.log(c.dim(`  │ ${pending}`));
        tail.push(pending);
      }
      resolve({ code, timedOut, tail: tail.join('\n') });
    };
    child.on('error', (error) => {
      tail.push(String(error.message));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

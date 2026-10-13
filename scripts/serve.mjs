#!/usr/bin/env node
/**
 * Serves dist/ the way GitHub Pages will: under a subpath, not at the root.
 *
 *   npm run preview                 → http://localhost:4380/mastre-gaming/
 *   npm run preview -- --port 5000 --base /somewhere/
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { c } from './lib/log.mjs';
import { DIST } from './lib/paths.mjs';
import { startStaticServer } from './lib/static.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4380' },
    base: { type: 'string', default: '/mastre-gaming/' },
    dir: { type: 'string' },
  },
});

const dir = values.dir ? path.resolve(values.dir) : DIST;
if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`Nothing to serve in ${dir}. Run "npm run build:all" first.`);
  process.exit(1);
}

const { url } = await startStaticServer({
  dir,
  base: values.base,
  port: Number(values.port),
  onRequest: ({ method, url: requested, status }) => {
    if (status >= 400) console.log(`${c.red(status)} ${method} ${requested}`);
  },
});

console.log(`\n  Mastre Gaming is at ${c.cyan(url)}\n  (only failed requests are logged; Ctrl+C to stop)\n`);

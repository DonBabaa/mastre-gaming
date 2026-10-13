import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { sendFromDir } from './scripts/lib/static.mjs';

// The real path, so Vite's file checks pass when the repo is reached through a link or a Windows short name.
const here = fs.realpathSync.native(import.meta.dirname);
const root = path.join(here, 'src');
const dist = path.join(here, 'dist');

/** `npm run dev`: serve the games, covers and catalog that the pipeline put in dist/. */
function serveBuiltGames(): Plugin {
  return {
    name: 'mastre:serve-built-games',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const urlPath = (req.url ?? '').split('?')[0];
        if (!/^\/(catalog\.json$|games\/|covers\/)/.test(urlPath)) return next();
        if (sendFromDir(req, res, dist, urlPath.slice(1)) === null) next();
      });
    },
  };
}

/**
 * The launcher and the games share dist/, so Vite must not empty it.
 * This removes only what a previous launcher build left behind.
 */
function cleanLauncherOutput(): Plugin {
  let outDir = dist;
  return {
    name: 'mastre:clean-launcher-output',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    buildStart() {
      for (const name of ['assets', 'index.html', 'play.html']) {
        fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
      }
    },
  };
}

export default defineConfig({
  root,
  // Relative URLs everywhere: the site works at the domain root and under /mastre-gaming/ alike.
  base: './',
  plugins: [serveBuiltGames(), cleanLauncherOutput()],
  build: {
    outDir: dist,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: path.join(root, 'index.html'),
        play: path.join(root, 'play.html'),
      },
    },
  },
});

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isInside } from './fsx.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

/**
 * Sends one file from `dir`, behaving like GitHub Pages: a folder without a trailing
 * slash redirects to the one with it, and a folder serves its index.html.
 * Returns the status code it sent, or null if nothing matched (the caller decides).
 */
export function sendFromDir(req, res, dir, urlPath) {
  let relative;
  try {
    relative = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (relative.includes('\0')) return null;
  let file = path.join(dir, relative);
  if (!isInside(dir, file)) return null;

  let stat = fs.statSync(file, { throwIfNoEntry: false });
  if (stat?.isDirectory()) {
    if (!urlPath.endsWith('/') && urlPath !== '') {
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: `${req.url.split('?')[0]}/${query}` }).end();
      return 301;
    }
    file = path.join(file, 'index.html');
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat?.isFile()) return null;

  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
  };

  // Audio and video elements ask for byte ranges.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
      return 416;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file, { start, end }).pipe(res);
    return 206;
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
  return 200;
}

/**
 * Serves `dir` under `base` (for example "/mastre-gaming/"), the way the hub sits
 * under a subpath on GitHub Pages. Anything outside `base` is a 404 on purpose:
 * that is exactly how an absolute "/asset.png" fails in production.
 */
export function startStaticServer({ dir, base = '/', port = 4173, onRequest = () => {} }) {
  const prefix = `/${base.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0].split('#')[0];
    let status = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      status = 405;
      res.writeHead(405).end();
    } else if (prefix !== '/' && (urlPath === '/' || urlPath === prefix.slice(0, -1))) {
      status = 302;
      res.writeHead(302, { Location: prefix }).end();
    } else if (urlPath.startsWith(prefix)) {
      status = sendFromDir(req, res, dir, urlPath.slice(prefix.length));
    }
    if (status === null) {
      status = 404;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`404 Not found: ${urlPath}\n`);
    }
    onRequest({ method: req.method, url: req.url, status });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve({ server, url: `http://localhost:${port}${prefix}` }));
  });
}

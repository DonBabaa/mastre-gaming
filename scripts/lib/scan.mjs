import fs from 'node:fs';
import path from 'node:path';
import { formatBytes, walkFiles } from './fsx.mjs';

export const MAX_BUILD_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_COVER_BYTES = 500 * 1024;

const MAX_SCANNED_BYTES = 30 * 1024 * 1024;
const MAX_EXAMPLES = 6;

const ASSET_EXT = [
  'png', 'jpe?g', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'ktx2', 'basis', 'hdr', 'exr',
  'mp3', 'ogg', 'wav', 'm4a', 'flac', 'mp4', 'webm',
  'glb', 'gltf', 'bin', 'fbx', 'obj', 'mtl', 'wasm', 'data',
  'js', 'mjs', 'css', 'json', 'xml', 'txt', 'atlas', 'fnt', 'woff2?', 'ttf', 'otf',
].join('|');

// A leading "/" that is not "//" (protocol-relative URLs are fine).
const HTML_ATTR = /\b(?:src|href|poster|data|action)\s*=\s*(["'])(\/(?!\/)[^"']*)\1/gi;
const CSS_URL = /url\(\s*(["']?)(\/(?!\/)[^)"'\s]+)\1\s*\)/gi;
const JS_STRING = new RegExp(`(["'\`])(\\/(?!\\/)[\\w@%+~.\\-/]*\\.(?:${ASSET_EXT}))(?:[?#][^"'\`]*)?\\1`, 'gi');

const SERVICE_WORKER = /serviceWorker\s*(?:\?\.|\.)\s*register\s*\(/;
const STORAGE_CLEAR = /\b(?:local|session)Storage\s*\.\s*clear\s*\(/;

function matches(text, pattern) {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => match[2]);
}

/**
 * Looks through a finished build for the things that break a game once it lives in
 * a subfolder next to other games. Everything found here is a warning, never a failure.
 * Returns { sizeBytes, fileCount, signals, warnings: [{ code, message }] }.
 */
export function scanBuild(dir) {
  const warnings = [];
  const absolute = [];
  const serviceWorkers = [];
  const storageClears = [];
  const bigFiles = [];
  const signals = { ready: false, exit: false };
  let sizeBytes = 0;
  let fileCount = 0;

  for (const file of walkFiles(dir)) {
    sizeBytes += file.size;
    fileCount += 1;
    if (file.size > MAX_FILE_BYTES) bigFiles.push(`${file.rel} (${formatBytes(file.size)})`);

    const ext = path.extname(file.rel).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    const isCss = ext === '.css';
    const isJs = ext === '.js' || ext === '.mjs';
    if (!(isHtml || isCss || isJs) || file.size > MAX_SCANNED_BYTES) continue;

    const text = fs.readFileSync(file.abs, 'utf8');
    const found = new Set([
      ...(isHtml ? matches(text, HTML_ATTR) : []),
      ...matches(text, CSS_URL),
      ...(isHtml || isJs ? matches(text, JS_STRING) : []),
    ]);
    for (const url of found) absolute.push(`${file.rel}: ${url}`);

    if (isHtml || isJs) {
      if (SERVICE_WORKER.test(text)) serviceWorkers.push(file.rel);
      if (STORAGE_CLEAR.test(text)) storageClears.push(file.rel);
      if (text.includes('mastre:ready')) signals.ready = true;
      if (text.includes('mastre:exit')) signals.exit = true;
    }
  }

  const list = (items) => {
    const shown = items.slice(0, MAX_EXAMPLES).join(', ');
    return items.length > MAX_EXAMPLES ? `${shown} and ${items.length - MAX_EXAMPLES} more` : shown;
  };

  if (absolute.length) {
    warnings.push({
      code: 'absolute-path',
      message: `absolute "/" paths will break in a subfolder, use relative paths: ${list(absolute)}`,
    });
  }
  if (serviceWorkers.length) {
    warnings.push({
      code: 'service-worker',
      message: `registers a Service Worker, which would take over the other games too: ${list(serviceWorkers)}`,
    });
  }
  if (storageClears.length) {
    warnings.push({
      code: 'storage-clear',
      message: `clears all of localStorage/sessionStorage, which wipes the other games' saves: ${list(storageClears)}`,
    });
  }
  if (sizeBytes > MAX_BUILD_BYTES) {
    warnings.push({
      code: 'too-large',
      message: `build is ${formatBytes(sizeBytes)}, over the ${formatBytes(MAX_BUILD_BYTES)} limit`,
    });
  }
  if (bigFiles.length) {
    warnings.push({ code: 'large-file', message: `single files over ${formatBytes(MAX_FILE_BYTES)}: ${list(bigFiles)}` });
  }

  return { sizeBytes, fileCount, signals, warnings };
}

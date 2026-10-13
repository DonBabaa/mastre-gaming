// A build step with no dependencies: copy src/ to dist/ and stamp the build time.
import fs from 'node:fs';

fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('src', 'dist', { recursive: true });

const page = fs.readFileSync('dist/index.html', 'utf8');
fs.writeFileSync('dist/index.html', page.replace('__BUILD__', new Date().toISOString().slice(0, 16).replace('T', ' ')));

console.log('Built dist/');

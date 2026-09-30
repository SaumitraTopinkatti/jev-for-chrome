// Guard (M7): dist/content.js is injected as a classic content script, not a
// module, so it must stay import-free. Any future value import shared with the
// background entry would make Rollup emit a shared chunk and silently break
// the content script. Fails the build if content.js contains ESM imports or a
// content chunk appeared in dist/assets/.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const fail = (msg) => { console.error(`check-content-bundle: ${msg}`); process.exit(1); };

const content = join(dist, 'content.js');
if (!existsSync(content)) fail('dist/content.js missing; run `vite build` first');
const src = readFileSync(content, 'utf8');
// Strip comments (naive but adequate: imports live at statement level, and a
// match inside a string literal is not a real import — accept that blind spot;
// the chunk check below is the backstop).
const stripped = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^\S\n])\/\/[^\n]*/g, '$1');
if (/(^|[\s;{}(),])import[\s('"{*]/.test(stripped) || /\bimport\s*\(/.test(stripped)) {
  fail('dist/content.js contains ESM import statements — content scripts are not modules');
}

const assets = join(dist, 'assets');
if (existsSync(assets)) {
  const chunks = readdirSync(assets).filter((f) => /^content[-.].*\.js$/.test(f));
  if (chunks.length) fail(`Rollup emitted a content chunk (${chunks.join(', ')}) — shared import with background?`);
}

console.log('check-content-bundle: dist/content.js is import-free');

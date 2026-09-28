// Zip dist/ into the release asset: release/jev-for-chrome-extension-<version>.zip
//
// The name must not collide with GitHub's own "Source code (zip)" archive, which for tag vX.Y.Z
// is called jev-for-chrome-X.Y.Z.zip and unzips to jev-for-chrome-X.Y.Z/ — the repository,
// with manifest.json under public/. Until 1.5.3 the asset had exactly that name, so both
// downloads unzipped to the same folder and Chrome's "Load unpacked" on the wrong one said
// "Manifest file is missing or unreadable" (issue #1).
//
// Entries sit at the zip root, so unzipping gives one folder that directly contains
// manifest.json: the folder to pick in "Load unpacked".
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync, unzipSync } from 'fflate';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const fail = (msg) => { console.error(`package: ${msg}`); process.exit(1); };

if (!existsSync(join(dist, 'manifest.json'))) fail('dist/manifest.json missing; run `npm run build` first');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  fail(`dist/manifest.json is ${manifest.version} but package.json is ${pkg.version}`);
}

// every file the manifest points at has to be in the zip, or Chrome refuses to load it
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
].filter(Boolean);
const missing = [...new Set(referenced)].filter((f) => !existsSync(join(dist, f)));
if (missing.length) fail(`manifest points at files not in dist/: ${missing.join(', ')}`);

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else files[relative(dist, full).split('\\').join('/')] = readFileSync(full);
  }
};
walk(dist);

// fixed timestamps so the same dist/ always gives the same bytes
const zip = zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') });

// read it back: manifest.json at the root, nothing nested under a top folder
const back = Object.keys(unzipSync(zip));
if (!back.includes('manifest.json')) fail('manifest.json is not at the zip root');

const name = `jev-for-chrome-extension-${pkg.version}.zip`;
mkdirSync(join(root, 'release'), { recursive: true });
writeFileSync(join(root, 'release', name), zip);
console.log(`release/${name}  ${back.length} files, ${(zip.length / 1024).toFixed(1)} KB`);

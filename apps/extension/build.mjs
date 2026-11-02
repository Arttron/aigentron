#!/usr/bin/env node
// Builds the extension TEMPLATE: src/ → dist/ (the part the server ships). The server never builds anything: it copies dist/ and writes only its
// configuration (manifest.json addresses / name / key, config.json) into the zip. Today the sources are plain ES modules, so "building" is
// validating and copying; a compile step (TypeScript, a bundled panel) would be added here and nothing else changes.
//
//   node build.mjs            build into ./dist
//   node build.mjs --check    validate only (the typecheck task)
//   node build.mjs --out DIR  build into DIR (tests)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');
const args = process.argv.slice(2);
const check = args.includes('--check');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : join(here, 'dist');

const problems = [];
const fail = (m) => problems.push(m);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

// ---- validate -------------------------------------------------------------------------------------------------------------
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
} catch (e) {
  fail(`manifest.json is not valid JSON: ${e.message}`);
}
if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  const need = (rel, what) => {
    if (typeof rel !== 'string' || !existsSync(join(SRC, rel))) fail(`${what} points to a file that is missing: ${rel}`);
  };
  need(manifest.background?.service_worker, 'background.service_worker');
  need(manifest.action?.default_popup, 'action.default_popup');
  if (manifest.side_panel?.default_path) need(manifest.side_panel.default_path, 'side_panel.default_path');
  for (const [i, c] of (manifest.content_scripts ?? []).entries()) for (const f of c.js ?? []) need(f, `content_scripts[${i}].js`);
  for (const [size, f] of Object.entries(manifest.icons ?? {})) need(f, `icons.${size}`);
  // the template must stay narrow: the server writes the real addresses. `<all_urls>` is allowed ONLY as an OPTIONAL permission (the person grants it
  // in the popup to see approval cards on any page); asked up front it would be a regression
  const { optional_host_permissions: optional, ...required } = manifest;
  if (JSON.stringify(required).includes('<all_urls>')) fail('the template must not ask for <all_urls> up front (only as optional_host_permissions)');
  if (optional && JSON.stringify(optional) !== '["<all_urls>"]') fail('optional_host_permissions may only be ["<all_urls>"]');
  for (const f of ['overlay.js', 'offscreen.html', 'offscreen.js', 'mic.html', 'mic.js', 'update.html', 'update.js']) if (!existsSync(join(SRC, f))) fail(`${f} is missing`);
  if (manifest.key || manifest.version === undefined) fail('the template has a `key` or no version (the server sets both)');
}
for (const f of files(SRC).filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`${relative(SRC, f)}: ${String(e.stderr ?? e.message).split('\n').find((l) => /Error/.test(l)) ?? 'syntax error'}`);
  }
}
for (const f of files(SRC).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^":]+)"/g)) if (!existsSync(join(dirname(f), m[1]))) fail(`${relative(SRC, f)} refers to ${m[1]}, which is missing`);
}

if (problems.length) {
  console.error(`extension: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
if (check) {
  console.log('extension: sources are valid');
  process.exit(0);
}

// ---- build ----------------------------------------------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(SRC, OUT, { recursive: true, filter: (p) => !p.endsWith('.DS_Store') && !/\.test\.(js|ts)$/.test(p) });
const count = files(OUT).length;
console.log(`extension: ${count} files → ${relative(process.cwd(), OUT) || OUT} (${statSync(join(OUT, 'manifest.json')).size} B manifest)`);

#!/usr/bin/env node
/*
 * `npm run doctor` — is this machine able to render a video?
 *
 * Everything the pipeline needs that Node does not provide, checked in one
 * place, with the install command for *this* platform rather than the one the
 * author happened to be using.
 */
import { platform, arch } from 'node:process';
import { nodeVersion, chromium, ffmpeg, heic, glyph } from '../lib/env.js';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const tty = process.stdout.isTTY;
const c = (color, s) => (tty ? `${color}${s}${OFF}` : s);

const rows = [];
const add = (level, name, detail, hint) => rows.push({ level, name, detail, hint });

const node = nodeVersion();
add(node.ok ? 'ok' : 'fail', 'Node', `v${node.version}`,
    node.ok ? null : `Need v${node.min} or newer.`);

const chrome = await chromium();
add(chrome.ok ? 'ok' : 'fail', 'Chromium',
    chrome.ok ? shorten(chrome.path) : 'not found', chrome.hint);

const enc = ffmpeg();
// "bundled" is the happy path — it means npm install provided it and the user
// never had to install anything by hand.
add(enc.ok ? 'ok' : 'fail', 'ffmpeg',
    enc.ok
      ? `${enc.version ?? 'present'}  ${c(DIM, enc.source === 'bundled' ? 'bundled with npm install' : shorten(enc.path))}`
      : 'not found',
    enc.ok ? null : enc.hint);

// Not having a HEIC decoder only matters if the hike has iPhone photos in it,
// so this is a warning rather than a failure.
const h = heic();
add(h.ok ? 'ok' : 'warn', 'HEIC decoder',
    h.ok ? `${h.tool}  ${c(DIM, shorten(h.path))}` : 'none',
    h.ok ? null : `Only needed for iPhone .HEIC photos. ${h.hint}`);

/* ------------------------------------------------------------------ output */

console.log(`\n  hike-viewer doctor        ${c(DIM, `${platform}/${arch}`)}\n`);

const pad = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const mark = r.level === 'ok' ? c(GREEN, glyph.ok)
             : r.level === 'warn' ? c(YELLOW, glyph.warn)
             : c(RED, glyph.fail);
  console.log(`  ${mark} ${r.name.padEnd(pad)}  ${r.detail}`);
  if (r.hint) console.log(`      ${c(DIM, r.hint)}`);
}

const failed = rows.filter((r) => r.level === 'fail');
const warned = rows.filter((r) => r.level === 'warn');

console.log();
if (failed.length) {
  const n = failed.length === 1 ? 'one thing' : `${failed.length} things`;
  console.log(`  ${c(RED, `Cannot render yet — ${n} missing above.`)}`);
  console.log(`  ${c(DIM, 'The map and the in-page preview still work without them.')}\n`);
  process.exit(1);
}
console.log(`  ${c(GREEN, 'Ready to render.')}${warned.length ? c(DIM, '  (one optional item above)') : ''}`);
console.log(`  ${c(DIM, 'npm start  →  http://localhost:5173')}\n`);

// Home directories in a path are noise; the interesting part is the tail.
function shorten(p) {
  if (!p) return '';
  const home = process.env.HOME;
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

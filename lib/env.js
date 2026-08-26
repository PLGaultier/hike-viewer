/*
 * What this machine can and cannot do.
 *
 * The render pipeline leans on three things that are not part of Node: a
 * Chromium to draw the map, ffmpeg to encode the frames, and — only for iPhone
 * photos — something that can decode HEIC. On the machine this was written on
 * all three happened to be there. On a fresh clone they may not be, and the
 * failures are otherwise dreadful: ffmpeg runs *after* the last frame, so a
 * missing binary wastes the entire render before saying so.
 *
 * Everything here is a lookup with no side effects, so the server, the
 * renderer and `npm run doctor` can all ask the same questions.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { platform } from 'node:process';

// ffmpeg-static ships a prebuilt binary for this platform, so `npm install` is
// the whole installation. That matters more than it sounds: the alternative is
// telling someone to install Homebrew — which means Xcode Command Line Tools,
// a gigabyte of download and an admin password — before they can watch their
// own hike. Loaded through require so a failed or skipped install degrades to
// "use whatever is on PATH" instead of crashing at import time.
let bundledFfmpeg = null;
try {
  bundledFfmpeg = createRequire(import.meta.url)('ffmpeg-static');
} catch { /* fall back to the system one */ }

// Node 20.11 is where import.meta.dirname landed, which render/record.mjs uses.
export const NODE_MIN = [20, 11, 0];

export function nodeVersion() {
  const parts = process.versions.node.split('.').map(Number);
  const ok =
    parts[0] > NODE_MIN[0] || (parts[0] === NODE_MIN[0] && parts[1] >= NODE_MIN[1]);
  return { version: process.versions.node, ok, min: NODE_MIN.join('.') };
}

// `which`, without a shell. Returns the resolved path or null.
export function which(bin) {
  try {
    const out = execFileSync(platform === 'win32' ? 'where' : 'which', [bin], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.toString().split('\n')[0].trim();
    return first || null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- glyphs */

// A legacy Windows console renders block-drawing characters and check marks as
// mojibake unless its code page happens to be UTF-8, and nothing guarantees
// that. start.bat sets it, but `npm start` typed into a bare cmd.exe does not,
// so the structural symbols degrade to ASCII there.
export const glyph = platform === 'win32'
  ? { ok: '[ok]', fail: '[XX]', warn: '[ !]', full: '#', empty: '.' }
  : { ok: '\u2713', fail: '\u2717', warn: '!', full: '\u2588', empty: '\u2591' };

/* ------------------------------------------------------------------ ffmpeg */

export function ffmpeg() {
  // An FFMPEG that points at nothing is worse than no FFMPEG at all: it would
  // report ready here and fail at the encode step an hour later.
  const override = process.env.FFMPEG;
  if (override && !existsSync(override)) {
    return { ok: false, path: override, version: null, source: 'FFMPEG',
             hint: `FFMPEG points at ${override}, which does not exist` };
  }

  // Explicit override first, then the bundled binary, then the system one.
  let path = override, source = 'FFMPEG';
  if (!path && bundledFfmpeg && existsSync(bundledFfmpeg)) {
    path = bundledFfmpeg;
    source = 'bundled';
  }
  if (!path) {
    path = which('ffmpeg');
    source = 'system';
  }
  if (!path) {
    return { ok: false, path: null, version: null, source: null,
             hint: `Reinstall dependencies with \`npm install\`, or install it with:  ${installHint('ffmpeg')}` };
  }
  let version = null;
  try {
    version = execFileSync(path, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n')[0].replace(/^ffmpeg version /, '').split(' ')[0];
  } catch { /* present but unrunnable is still present enough to report */ }
  return { ok: true, path, version, source, hint: null };
}

/* ---------------------------------------------------------------- chromium */

// Puppeteer downloads its own Chromium on install (~550 MB). If someone set
// PUPPETEER_SKIP_DOWNLOAD, or the install was interrupted, the browser is
// simply not there and puppeteer.launch() fails with a wall of text.
export async function chromium() {
  const override = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (override) {
    return existsSync(override)
      ? { ok: true, path: override, source: 'PUPPETEER_EXECUTABLE_PATH' }
      : { ok: false, path: override, source: 'PUPPETEER_EXECUTABLE_PATH',
          hint: `PUPPETEER_EXECUTABLE_PATH points at ${override}, which does not exist.` };
  }
  try {
    const { default: puppeteer } = await import('puppeteer');
    // Returns a promise as of puppeteer 25; awaiting a plain string is a no-op,
    // so this stays correct if that ever goes back to being synchronous.
    const path = await puppeteer.executablePath();
    return existsSync(path)
      ? { ok: true, path, source: 'puppeteer' }
      : { ok: false, path, source: 'puppeteer',
          hint: 'Chromium is missing. Run:  npx puppeteer browsers install chrome' };
  } catch (err) {
    return { ok: false, path: null, source: 'puppeteer',
             hint: `puppeteer is not installed (${err.message}). Run:  npm install` };
  }
}

/* -------------------------------------------------------------------- HEIC */

// sharp cannot open iPhone HEICs (libheif rejects them for carrying 48
// references in the iref box against a hardening limit of 16), so they go
// through an external decoder first. macOS has one built in; elsewhere it is
// libheif's own CLI, which is packaged nearly everywhere.
export function heic() {
  if (platform === 'darwin') {
    const path = which('sips');
    if (path) return { ok: true, tool: 'sips', path };
  }
  const path = which('heif-convert');
  if (path) return { ok: true, tool: 'heif-convert', path };
  return { ok: false, tool: null, path: null, hint: installHint('heif') };
}

/* ------------------------------------------------------------------- hints */

// Which package manager to name. Guessing wrong is worse than not guessing, so
// Linux is probed rather than assumed.
function linuxPackager() {
  if (which('apt-get')) return 'apt';
  if (which('dnf')) return 'dnf';
  if (which('pacman')) return 'pacman';
  if (which('zypper')) return 'zypper';
  return null;
}

export function installHint(what) {
  const cmds = {
    ffmpeg: {
      darwin: 'brew install ffmpeg',
      apt: 'sudo apt-get install ffmpeg',
      dnf: 'sudo dnf install ffmpeg',
      pacman: 'sudo pacman -S ffmpeg',
      zypper: 'sudo zypper install ffmpeg',
      win32: 'winget install Gyan.FFmpeg',
    },
    heif: {
      darwin: 'sips ships with macOS — if it is missing, something is very wrong',
      apt: 'sudo apt-get install libheif-examples',
      dnf: 'sudo dnf install libheif-tools',
      pacman: 'sudo pacman -S libheif',
      zypper: 'sudo zypper install libheif-tools',
      win32: 'no HEIC decoder on Windows — convert to JPEG first',
    },
  }[what];

  if (platform === 'darwin') return cmds.darwin;
  if (platform === 'win32') return cmds.win32;
  const pkg = linuxPackager();
  return pkg ? cmds[pkg] : `install ${what} with your package manager`;
}

/* ----------------------------------------------------- what a render needs */

// Called before a render starts rather than discovered during one. Chromium is
// needed to draw the frames and ffmpeg to encode them; HEIC is not checked
// because a hike without iPhone photos does not care.
export async function renderPrereqs() {
  const missing = [];
  const node = nodeVersion();
  if (!node.ok) missing.push(`Node ${node.min}+ required, this is ${node.version}`);

  const chrome = await chromium();
  if (!chrome.ok) missing.push(chrome.hint);

  const enc = ffmpeg();
  if (!enc.ok) missing.push(`ffmpeg is not available. ${enc.hint}`);

  return { ok: missing.length === 0, missing };
}

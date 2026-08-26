#!/usr/bin/env node
/*
 * Turns whatever the browser produced into a shareable MP4.
 *
 * This was a bash script until Windows needed to run it. Bash is the one thing
 * a stock Windows machine does not have, and it was the only reason the app
 * needed WSL there — every other dependency already ships a Windows build.
 * Node is the interpreter that is guaranteed to be present, since it is what
 * runs the app at all.
 *
 * Which frames, and where the MP4 lands, come from the environment so one
 * hike's render never overwrites another's:
 *   FRAMES=out/<hike>/frames  OUT=out/<hike>/hike.mp4
 * Run bare, it falls back to out/frames → out/hike.mp4.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ffmpeg } from '../lib/env.js';

const ROOT = resolve(import.meta.dirname, '..');
process.chdir(ROOT);

const FPS = process.env.FPS || '30';
// Terrain this detailed is expensive to encode: crf 20 lands a 60s 1080p render
// at ~115MB, which is awkward to share. 23 is hard to tell apart in motion and
// roughly halves that. Override with CRF= for an archival master.
const CRF = process.env.CRF || '23';
const FRAMES = process.env.FRAMES || 'out/frames';
const OUT = process.env.OUT || 'out/hike.mp4';

const die = (msg) => { console.error(msg); process.exit(1); };

function human(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

// The renderer passes FFMPEG=; run bare it is unset. Either way this is the
// same lookup the server and `npm run doctor` use — bundled binary first, then
// whatever is on PATH — rather than a second copy of that logic.
const enc = ffmpeg();
if (!enc.ok) die(`ffmpeg not found. ${enc.hint}`);

/* ------------------------------------------------------------------ frames */

// The renderer writes .jpg; .png support stays for anything captured earlier.
function findFrames() {
  if (!existsSync(FRAMES)) return null;
  const files = readdirSync(FRAMES);
  for (const ext of ['jpg', 'png']) {
    const re = new RegExp(`^f(\\d{6})\\.${ext}$`);
    const hits = files.map((f) => re.exec(f)).filter(Boolean);
    if (hits.length) {
      return {
        ext,
        count: hits.length,
        // ffmpeg guesses where a %06d sequence starts and gives up if it
        // guesses wrong. The first frame is right here in the listing.
        start: Math.min(...hits.map((m) => Number(m[1]))),
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ encode */

// yuv420p + even dimensions keep the file playable in QuickTime, Photos, and
// anything that expects H.264 baseline-ish output rather than a browser codec.
const QUIET = ['-hide_banner', '-loglevel', 'error'];
const COMMON = [
  '-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p',
  '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart',
];

const frames = findFrames();
let args;

if (frames) {
  console.log(`Encoding ${frames.count} frames at ${FPS}fps → ${OUT}`);
  args = [
    '-y', ...QUIET,
    '-framerate', FPS,
    '-start_number', String(frames.start),
    '-i', join(FRAMES, `f%06d.${frames.ext}`),
    ...COMMON, OUT,
  ];
} else if (existsSync('out/hike.webm')) {
  console.log(`Transcoding out/hike.webm → ${OUT}`);
  args = ['-y', ...QUIET, '-i', 'out/hike.webm', ...COMMON, OUT];
} else {
  die(`Nothing to encode in ${FRAMES}. Render a video in the browser first.`);
}

mkdirSync(dirname(OUT), { recursive: true });

const child = spawn(enc.path, args, { stdio: 'inherit' });
child.on('error', (err) => die(`could not run ffmpeg: ${err.message}`));
child.on('exit', (code) => {
  if (code !== 0) die(`\nffmpeg exited with code ${code}`);
  console.log(`\n  ${OUT}  (${human(statSync(OUT).size)})`);
});

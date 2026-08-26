/*
 * Headless renderer: drives the app in a real GPU-backed Chrome and writes
 * out/<hike>/hike.mp4 — no visible tab, no babysitting.
 *
 * Chrome stops running requestAnimationFrame in background tabs, and MapLibre
 * draws on it, so an interactive render dies the moment you switch away. The
 * launch flags below turn that throttling off, which is the whole reason this
 * path exists.
 */
import puppeteer from 'puppeteer';
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { platform } from 'node:process';
import { renderPrereqs, ffmpeg } from '../lib/env.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

// One preset, chosen to look right on any hike. Overridable from the command
// line, but nothing in the UI asks the user to pick.
const DURATION = Number(arg('duration', 60));
const DWELL    = Number(arg('dwell', 4));
const RES      = Number(arg('res', 1080));
const FPS      = Number(arg('fps', 30));
const PORT     = Number(arg('port', 5199));
// Which hike to render. Omitted from the CLI it means "whatever the server
// would show by default" — the folder hike, or the most recent drop.
const HIKE     = arg('hike', '');

const ROOT = resolve(import.meta.dirname, '..');
const SIZES = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };
const [OUT_W, OUT_H] = SIZES[RES] ?? SIZES[1080];
const PANEL = 330;   // control panel width, excluded from the captured area

const run = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
    p.on('error', rej);
  });

// ------------------------------------------------------------- preflight

// ffmpeg runs *after* the last frame. Discovering it is missing there means
// throwing away the whole render, so everything the pipeline needs is checked
// before a single frame is drawn.
const prereq = await renderPrereqs();
if (!prereq.ok) {
  console.error('\nCannot render — this machine is missing:\n');
  for (const m of prereq.missing) console.error(`  • ${m}`);
  console.error('\nRun `npm run doctor` for the full picture.\n');
  process.exit(1);
}

// ---------------------------------------------------------------- server

const query = HIKE ? `?id=${encodeURIComponent(HIKE)}` : '';

const reachable = async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/api/hike${query}`);
    return r.ok ? r.json() : null;
  } catch { return null; }
};

// When the app itself launched this render, a server is already listening on
// that port; only start our own when running standalone from the CLI.
let server = null;
let hike = await reachable();
if (!hike) {
  console.log('Starting server…');
  // process.execPath, not 'node': the interpreter running this script is the
  // one that should run the server. Bare 'node' is not always on PATH — under
  // nvm, or on Windows where npm resolves it differently.
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  for (let i = 0; i < 60 && !hike; i++) {
    await new Promise((r) => setTimeout(r, 500));
    hike = await reachable();
  }
  if (!hike) throw new Error('server did not come up');
}
if (hike.empty || hike.error) {
  throw new Error(hike.reason ?? hike.error ?? 'no hike to render');
}
if (!hike.photos?.length) console.log('  (no photos placed on the track)');

const ID = hike.id;
const OUT_DIR = `${ROOT}/out/${ID}`;
console.log(`  hike    ${ID} — ${hike.source.gpx}`);

// ---------------------------------------------------------------- browser

console.log('Launching headless Chrome…');
// Chrome's sandbox needs user namespaces, which a container or a root shell
// usually does not give it — the common Linux "failed to launch" case. Dropping
// the sandbox is only acceptable because the page being loaded is this app on
// localhost, not arbitrary web content.
const linuxArgs = platform === 'linux'
  // process.geteuid is POSIX-only, hence the guard rather than a bare call.
  ? ['--disable-dev-shm-usage',
     ...(typeof process.geteuid === 'function' && process.geteuid() === 0 ? ['--no-sandbox'] : [])]
  : [];

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    ...linuxArgs,
    // Without these Chrome throttles the render loop to a standstill whenever
    // it decides the page is not visible, and no frames are ever produced.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--use-gl=angle',
    '--enable-unsafe-swiftshader',   // harmless fallback if there is no GPU
    '--hide-scrollbars',
  ],
});

const page = await browser.newPage();
// Size the window so the 16:9 stage is exactly the output resolution — the map
// canvas is then captured 1:1 with no resampling.
await page.setViewport({
  width: OUT_W + PANEL,
  height: Math.max(OUT_H, Math.round((OUT_W * 9) / 16)),
  deviceScaleFactor: 1,
});
page.on('pageerror', (e) => console.error('  page error:', e.message));

// ?hike= pins the page to the hike we resolved above, so a render never drifts
// onto whatever the server happens to consider current.
await page.goto(`http://localhost:${PORT}/?hike=${encodeURIComponent(ID)}`, {
  waitUntil: 'networkidle2', timeout: 120000,
});

console.log('STAGE terrain');
console.log('Waiting for terrain…');
await page.waitForFunction(
  () => typeof map !== 'undefined' && map && map.getSource && !!map.getSource('trail'),
  { timeout: 180000, polling: 500 }
);
await page.waitForFunction(() => map.areTilesLoaded(), { timeout: 180000, polling: 500 });

// ---------------------------------------------------------------- configure

const setup = await page.evaluate(
  async (cfg) => {
    opts.duration = cfg.duration;
    opts.dwell = cfg.dwell;
    opts.res = cfg.res;
    buildTimeline();

    await warmPhotos();
    const canvas = map.getCanvas();
    return {
      total: Math.round(totalDuration() * cfg.fps),
      duration: totalDuration(),
      canvas: [canvas.width, canvas.height],
      visibility: document.visibilityState,
      hike: hikeId,
      photos: hike.photos.map((p) => p.file),
    };
  },
  { duration: DURATION, dwell: DWELL, res: RES, fps: FPS }
);

if (setup.hike !== ID) throw new Error(`page loaded hike ${setup.hike}, expected ${ID}`);

console.log(
  `  ${setup.total} frames · ${setup.duration.toFixed(1)}s · ${OUT_W}x${OUT_H} @${FPS}fps · ` +
  `map canvas ${setup.canvas.join('x')} · page ${setup.visibility}`
);
console.log(`PROGRESS 0/${setup.total}`);

// ---------------------------------------------------------------- frames

rmSync(`${OUT_DIR}/frames`, { recursive: true, force: true });
mkdirSync(`${OUT_DIR}/frames`, { recursive: true });

// Rendered in slices so progress is visible and no single evaluate runs long
// enough to look hung.
const SLICE = 20;
const started = Date.now();

for (let from = 0; from < setup.total; from += SLICE) {
  const to = Math.min(from + SLICE, setup.total);
  await page.evaluate(
    async (a, b, fps) => {
      for (let n = a; n < b; n++) {
        const st = applyState(n / fps);
        await settled(6000);              // hold each frame until every tile is in
        const c = composite(st);
        await fetch(`/api/frame?n=${n}&hike=${hikeId}`, {
          method: 'POST',
          body: c.toDataURL('image/jpeg', 0.94),
        });
      }
    },
    from, to, FPS
  );

  const done = to;
  const rate = (Date.now() - started) / done;
  const eta = Math.round((rate * (setup.total - done)) / 1000);
  process.stdout.write(
    `\r  ${done}/${setup.total} frames (${((done / setup.total) * 100).toFixed(0)}%)  ~${eta}s left   `
  );
  // Parsed by server.js to drive the progress bar in the page.
  console.log(`\nPROGRESS ${done}/${setup.total}`);
}
console.log();

await browser.close();
server?.kill();

const count = existsSync(`${OUT_DIR}/frames`) ? readdirSync(`${OUT_DIR}/frames`).length : 0;
if (count < setup.total) console.warn(`  warning: ${count} frames on disk, expected ${setup.total}`);

// ---------------------------------------------------------------- encode

console.log('STAGE encoding');
console.log('Encoding…');
await run(process.execPath, ['render/to-mp4.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    FPS: String(FPS),
    FRAMES: `out/${ID}/frames`,
    OUT: `out/${ID}/hike.mp4`,
    // Resolved here (bundled binary, or the system one) so the shell script
    // does not have to repeat the lookup.
    FFMPEG: ffmpeg().path,
  },
});

// The frames were only ever an intermediate; 1800 JPEGs is half a gigabyte.
rmSync(`${OUT_DIR}/frames`, { recursive: true, force: true });
console.log(`\n  out/${ID}/hike.mp4`);

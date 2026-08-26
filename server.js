import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  existsSync, readdirSync, createReadStream, createWriteStream,
  mkdirSync, writeFileSync, statSync, rmSync,
} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join, extname, resolve, basename } from 'node:path';
import { platform } from 'node:process';
import { parseGpx } from './lib/gpx.js';
import { readPhoto } from './lib/photos.js';
import { placePhoto } from './lib/match.js';
import { makeThumb } from './lib/thumbs.js';
import { renderPrereqs, ffmpeg, chromium, glyph } from './lib/env.js';

const ROOT = resolve('.');
const UPLOADS = join(ROOT, 'uploads');
const PORT = Number(process.env.PORT) || 5173;

// The working folder itself is a hike, under this reserved id. It is how the
// POC worked and still works: drop a .gpx next to the code and it shows up.
// Everything dropped on the UI lands in uploads/<id>/ instead.
const FOLDER = 'folder';

const IMAGE_RE = /\.(jpe?g|png|heic)$/i;
const GPX_RE = /\.gpx$/i;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.map': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

/* --------------------------------------------------------------- hike ids */

// Ids are generated here and only ever come back from the client, but they are
// pasted straight into filesystem paths — so nothing that is not an id we could
// have issued is allowed anywhere near `join`.
const validId = (id) => (id === FOLDER || /^[a-z0-9]{4,32}$/.test(id) ? id : null);
const hikeDir = (id) => (id === FOLDER ? ROOT : join(UPLOADS, id));
const urlBase = (id) => (id === FOLDER ? '' : `/uploads/${id}`);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const findGpx = (dir) =>
  (existsSync(dir) ? readdirSync(dir) : []).find((f) => GPX_RE.test(f)) ?? null;

function describe(id) {
  const dir = hikeDir(id);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const gpx = files.find((f) => GPX_RE.test(f)) ?? null;
  return {
    id,
    gpx,
    label: id === FOLDER ? 'This folder' : (gpx ? gpx.replace(GPX_RE, '') : 'Incomplete'),
    photos: files.filter((f) => IMAGE_RE.test(f)).length,
    created: id === FOLDER ? 0 : (existsSync(dir) ? statSync(dir).birthtimeMs : 0),
  };
}

// The folder hike first (it is the one that was there before uploads existed),
// then dropped hikes newest first.
function listHikes() {
  const out = findGpx(ROOT) ? [describe(FOLDER)] : [];
  if (existsSync(UPLOADS)) {
    const dropped = readdirSync(UPLOADS)
      .filter((d) => validId(d) && d !== FOLDER && statSync(join(UPLOADS, d)).isDirectory())
      .map(describe)
      .sort((a, b) => b.created - a.created);
    out.push(...dropped);
  }
  return out;
}

// What to show when the page is opened without asking for a hike by id.
const defaultHikeId = () => listHikes().find((h) => h.gpx)?.id ?? null;

/* ------------------------------------------------------------ build a hike */

async function buildHike(id) {
  const dir = hikeDir(id);
  if (!existsSync(dir)) throw new Error(`Hike ${id} no longer exists.`);

  const files = readdirSync(dir);
  const gpxFile = files.find((f) => GPX_RE.test(f));
  if (!gpxFile) {
    throw new Error(id === FOLDER
      ? 'No .gpx file in this folder. Drop a GPX and photos onto the page instead.'
      : 'That upload has no .gpx file in it.');
  }

  const track = parseGpx(join(dir, gpxFile));

  const imageFiles = files.filter((f) => IMAGE_RE.test(f)).sort();
  const photos = [];
  const rejected = [];

  for (const f of imageFiles) {
    try {
      const meta = await readPhoto(join(dir, f));
      const placed = placePhoto(meta, track);
      if (placed.placed) {
        placed.src = `${urlBase(id)}/${await makeThumb(dir, f)}`;
        photos.push(placed);
      } else {
        rejected.push(placed);
      }
    } catch (err) {
      rejected.push({ file: f, placed: false, reason: err.message });
    }
  }

  photos.sort((a, b) => a.t - b.t);

  return {
    id,
    source: { gpx: gpxFile, name: track.name, photos: imageFiles.length, label: describe(id).label },
    video: `/out/${id}/hike.mp4`,
    track: {
      // Trim to what the client needs; the browser does not want 6283 objects
      // carrying fields it never reads.
      points: track.points.map((p) => [p.lon, p.lat, p.ele, p.t, p.dist]),
      stats: track.stats,
      gaps: track.gaps,
    },
    photos,
    rejected,
  };
}

// Parsing a GPX and re-reading EXIF for a dozen photos is not free, and the
// page asks for the same hike on every reload. Keyed by id so switching between
// hikes stays instant.
const cache = new Map();
async function hike(id, fresh) {
  if (!fresh && cache.has(id)) return cache.get(id);
  const built = await buildHike(id);
  cache.set(id, built);
  return built;
}

/* ------------------------------------------------------------------ render */

const render = {
  running: false, done: 0, total: 0, stage: 'idle', error: null, file: null, hike: null,
  startedAt: 0,
};

// The renderer's progress goes to the status object for the browser, but
// somebody who typed `npm start` is watching this terminal — and a render is
// minutes long. Without this it printed nothing at all until ffmpeg's output
// arrived at the very end, which reads as a hang followed by a crash.
const bar = (frac, width = 24) => {
  const filled = Math.round(frac * width);
  return glyph.full.repeat(filled) + glyph.empty.repeat(width - filled);
};

function humanEta(ms) {
  if (!isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `~${s}s left` : `~${Math.round(s / 60)}m left`;
}

let lastStage = null;
let lastPrinted = -1;

function showProgress() {
  const tty = process.stdout.isTTY;

  if (render.stage !== lastStage) {
    if (lastStage === 'rendering' && tty) process.stdout.write('\n');
    if (render.stage === 'terrain') console.log('  Loading terrain — the first tiles of a new area take a moment…');
    if (render.stage === 'encoding') console.log('  Encoding video…');
    lastStage = render.stage;
    lastPrinted = -1;
  }

  if (render.stage !== 'rendering' || !render.total) return;

  const frac = render.done / render.total;
  const pct = Math.round(frac * 100);
  const elapsed = Date.now() - render.startedAt;

  // The first frames are not representative — they carry the terrain load with
  // them, and dividing by a handful of frames swings the estimate wildly. It
  // read "~502m left" one second and "~25m left" the next, which is worse than
  // saying nothing. Wait for a couple of seconds of video before guessing.
  const warm = render.done >= 60 && elapsed > 10000;
  const eta = warm
    ? humanEta((elapsed / render.done) * (render.total - render.done))
    : 'estimating…';

  if (tty) {
    // One line, rewritten in place.
    process.stdout.write(
      `\r  Rendering  ${bar(frac)}  ${String(pct).padStart(3)}%   ` +
      `${render.done}/${render.total} frames  ${eta}   `
    );
  } else if (pct >= lastPrinted + 10) {
    // Piped to a file or a log: one line per 10% instead of thousands.
    lastPrinted = pct - (pct % 10);
    console.log(`  Rendering ${lastPrinted}%  (${render.done}/${render.total} frames)  ${eta}`);
  }
}

function startRender(id) {
  Object.assign(render, {
    running: true, done: 0, total: 0, stage: 'starting', error: null, file: null, hike: id,
    startedAt: Date.now(),
  });
  lastStage = null;
  lastPrinted = -1;
  console.log(`\n  Rendering hike ${id} — this takes a few minutes. Keep this window open.`);

  // process.execPath rather than 'node': whatever interpreter is running the
  // server is the one that should run the renderer. On a machine using nvm or
  // volta, plain 'node' can resolve to a different (older) install.
  const child = spawn(process.execPath, ['render/record.mjs', `--port=${PORT}`, `--hike=${id}`], { cwd: ROOT });
  let tail = '';
  // "renderer exited with code 1" tells the user nothing. Keep the last few
  // lines of stderr so the panel can show what actually went wrong.
  let errLines = [];

  const read = (buf) => {
    tail = (tail + buf.toString()).split('\n').slice(-1)[0];
    for (const line of (tail.includes('\r') ? tail.split('\r') : [buf.toString()])) {
      const p = /PROGRESS (\d+)\/(\d+)/.exec(line);
      if (p) { render.done = Number(p[1]); render.total = Number(p[2]); render.stage = 'rendering'; }
      if (/STAGE encoding/.test(line)) render.stage = 'encoding';
      if (/STAGE terrain/.test(line)) render.stage = 'terrain';
    }
    showProgress();
  };
  child.stdout.on('data', read);
  child.stderr.on('data', (b) => {
    process.stderr.write(b);
    errLines.push(...b.toString().split('\n').filter((l) => l.trim()));
    errLines = errLines.slice(-8);
  });

  child.on('error', (err) => {
    render.running = false;
    render.stage = 'failed';
    render.error = `could not start the renderer: ${err.message}`;
  });

  child.on('exit', (code) => {
    render.running = false;
    if (code === 0) {
      render.stage = 'done';
      render.file = `/out/${id}/hike.mp4?t=` + Date.now();
      const secs = Math.round((Date.now() - render.startedAt) / 1000);
      const mins = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
      console.log(`\n  ${glyph.ok} Done in ${mins}  ->  out/${id}/hike.mp4`);
      console.log('    It is playing in the browser now, and "Save video" downloads it.\n');
    } else {
      render.stage = 'failed';
      render.error = errLines.length
        ? errLines.join(' · ')
        : `renderer exited with code ${code}`;
      console.error(`\n  ${glyph.fail} Render failed: ${render.error}\n`);
    }
  });
}

/* ------------------------------------------------------------------ upload */

// Uploaded names go into a path, so keep the basename and nothing else. A file
// whose name survives to nothing gets one, rather than being written as "".
function safeName(name) {
  const base = basename(String(name ?? '')).replace(/[/\\]/g, '');
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '');
  return clean && /\.[a-z0-9]+$/i.test(clean) ? clean : null;
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

/* ------------------------------------------------------------------ routes */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  try {
    // Which hikes are available to switch between.
    if (path === '/api/hikes' && req.method === 'GET') {
      return json(res, 200, { hikes: listHikes(), default: defaultHikeId() });
    }

    // Opens a session to upload into. The client then PUTs one file per request
    // rather than a multipart POST — it keeps per-file progress honest and the
    // server free of a multipart parser.
    if (path === '/api/hikes' && req.method === 'POST') {
      const id = newId();
      mkdirSync(join(UPLOADS, id), { recursive: true });
      return json(res, 201, { id });
    }

    const fileUpload = /^\/api\/hikes\/([a-z0-9]+)\/file$/.exec(path);
    if (fileUpload && req.method === 'PUT') {
      const id = validId(fileUpload[1]);
      const name = safeName(url.searchParams.get('name'));
      if (!id || id === FOLDER) return json(res, 400, { error: 'bad hike id' });
      if (!name) return json(res, 400, { error: 'bad file name' });
      if (!existsSync(join(UPLOADS, id))) return json(res, 404, { error: 'no such upload' });

      const dest = join(UPLOADS, id, name);
      // Stream it: a hike is easily 100 MB of photos and there is no reason to
      // hold any of it in memory.
      await pipeline(req, createWriteStream(dest));
      cache.delete(id);
      return json(res, 201, { file: name, size: statSync(dest).size });
    }

    const hikeItem = /^\/api\/hikes\/([a-z0-9]+)$/.exec(path);
    if (hikeItem && req.method === 'DELETE') {
      const id = validId(hikeItem[1]);
      if (!id || id === FOLDER) return json(res, 400, { error: 'cannot delete that hike' });
      rmSync(join(UPLOADS, id), { recursive: true, force: true });
      rmSync(join(ROOT, 'out', id), { recursive: true, force: true });
      cache.delete(id);
      return json(res, 200, { deleted: id });
    }

    if (path === '/api/hike') {
      const id = validId(url.searchParams.get('id') ?? '') ?? defaultHikeId();
      if (!id) {
        return json(res, 200, {
          empty: true,
          reason: 'No hike loaded yet. Drop a .gpx and some photos onto the page.',
        });
      }
      const data = await hike(id, url.searchParams.has('fresh'));
      return json(res, 200, data);
    }

    // The frame renderer POSTs one JPEG per frame; ffmpeg stitches them later.
    if (path === '/api/frame' && req.method === 'POST') {
      const n = url.searchParams.get('n');
      const id = validId(url.searchParams.get('hike') ?? '');
      if (!id) return json(res, 400, { error: 'bad hike id' });
      const dir = join(ROOT, 'out', id, 'frames');
      mkdirSync(dir, { recursive: true });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      const m = /^data:image\/(png|jpeg);base64,/.exec(body);
      const ext = m?.[1] === 'png' ? 'png' : 'jpg';
      const img = Buffer.from(body.slice(m ? m[0].length : 0), 'base64');
      writeFileSync(join(dir, `f${String(n).padStart(6, '0')}.${ext}`), img);
      res.writeHead(204);
      return res.end();
    }

    // One click renders the whole video. The work runs in headless Chrome via a
    // child process rather than in this tab, so it does not matter whether the
    // user stays on the page — Chrome would otherwise stop drawing the moment
    // they switched away.
    if (path === '/api/render' && req.method === 'POST') {
      if (render.running) return json(res, 409, { error: 'already rendering' });
      const id = validId(url.searchParams.get('id') ?? '') ?? defaultHikeId();
      if (!id) return json(res, 400, { error: 'no hike to render' });

      // Checked here rather than left to fail mid-pipeline: ffmpeg only runs
      // after the last frame, so without this a missing binary costs the user
      // the entire render before it says anything.
      const prereq = await renderPrereqs();
      if (!prereq.ok) {
        return json(res, 503, {
          error: `${prereq.missing.join(' · ')} — run \`npm run doctor\` for details`,
        });
      }
      startRender(id);
      return json(res, 202, { started: true, hike: id });
    }

    if (path === '/api/render/status') return json(res, 200, render);

    return serveStatic(path, res, req);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

function serveStatic(path, res, req) {
  let file;
  if (path === '/') file = join(ROOT, 'public', 'index.html');
  else if (path.startsWith('/vendor/')) file = join(ROOT, 'node_modules', path.slice(8));
  else if (path.startsWith('/.cache/')) file = join(ROOT, path.slice(1));
  else if (path.startsWith('/uploads/')) file = join(ROOT, path.slice(1));
  else if (path.startsWith('/out/')) file = join(ROOT, path.slice(1));
  else if (existsSync(join(ROOT, 'public', path))) file = join(ROOT, 'public', path);
  else file = join(ROOT, path.slice(1));

  if (!resolve(file).startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const size = statSync(file).size;
  const range = req?.headers?.range;

  // Video players ask for byte ranges. Answering every one with a 200 and the
  // whole file means seeking silently does not work on a 100MB+ render.
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      return createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  createReadStream(file).pipe(res);
}

// Someone who just typed `npm start` should not also have to know to open a
// browser and type a URL. Skipped when there is no terminal attached, which is
// how render/record.mjs starts its own server.
function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || !process.stdout.isTTY) return;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: platform === 'win32' }).unref();
  } catch { /* not being able to open a browser is not worth failing over */ }
}

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  hike-viewer  →  ${url}\n`);
  openBrowser(url);

  // A fresh clone is the common case, and the two things that ruin it are a
  // missing prerequisite and not knowing what to do with an empty window. Say
  // both here, where whoever just typed `npm start` is looking.
  const enc = ffmpeg();
  const chrome = await chromium();
  if (!enc.ok || !chrome.ok) {
    console.log('  the map works, but video rendering is unavailable:');
    if (!chrome.ok) console.log(`    ${glyph.fail} Chromium — ${chrome.hint}`);
    if (!enc.ok) console.log(`    ${glyph.fail} ffmpeg — ${enc.hint}`);
    console.log('    run `npm run doctor` for the full picture\n');
  }

  const id = defaultHikeId();
  if (!id) {
    console.log('  No hike loaded yet.');
    console.log('  Drag a .gpx and its photos onto the page — a folder of photos works too.\n');
    return;
  }
  hike(id, true)
    .then((h) => {
      const km = (h.track.stats.distance / 1000).toFixed(1);
      const hrs = (h.track.stats.duration / 3600000).toFixed(1);
      console.log(`  track   ${h.source.gpx} — ${km} km, ${hrs} h, ${h.track.stats.count} pts`);
      console.log(`  photos  ${h.photos.length} placed, ${h.rejected.length} rejected`);
      for (const p of h.photos) {
        console.log(`     ✓ ${p.file}  km ${(p.dist / 1000).toFixed(2)}  ${p.ele.toFixed(0)}m  [${p.confidence}]`);
      }
      for (const p of h.rejected) console.log(`     ✗ ${p.file}  ${p.reason}`);
      console.log();
    })
    .catch((e) => console.error(`  ERROR  ${e.message}\n`));
});

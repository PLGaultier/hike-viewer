import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, createReadStream, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { parseGpx } from './lib/gpx.js';
import { readPhoto } from './lib/photos.js';
import { placePhoto } from './lib/match.js';
import { makeThumb } from './lib/thumbs.js';

const ROOT = resolve('.');
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.map': 'application/json', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

// Reads whatever GPX and photos are sitting in the folder. The POC deliberately
// has no upload step: drop files in, restart, watch the flyover.
async function buildHike() {
  const files = readdirSync(ROOT);
  const gpxFile = files.find((f) => f.toLowerCase().endsWith('.gpx'));
  if (!gpxFile) throw new Error('No .gpx file found in this folder.');

  const track = parseGpx(join(ROOT, gpxFile));

  const imageFiles = files.filter((f) => /\.(jpe?g|png|heic)$/i.test(f)).sort();
  const photos = [];
  const rejected = [];

  for (const f of imageFiles) {
    try {
      const meta = await readPhoto(join(ROOT, f));
      const placed = placePhoto(meta, track);
      if (placed.placed) {
        placed.src = await makeThumb(ROOT, f, meta.orientation);
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
    source: { gpx: gpxFile, name: track.name, photos: imageFiles.length },
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

const render = { running: false, done: 0, total: 0, stage: 'idle', error: null, file: null };

function startRender() {
  Object.assign(render, { running: true, done: 0, total: 0, stage: 'starting', error: null, file: null });

  const child = spawn('node', ['render/record.mjs', `--port=${PORT}`], { cwd: ROOT });
  let tail = '';

  const read = (buf) => {
    tail = (tail + buf.toString()).split('\n').slice(-1)[0];
    for (const line of (tail.includes('\r') ? tail.split('\r') : [buf.toString()])) {
      const p = /PROGRESS (\d+)\/(\d+)/.exec(line);
      if (p) { render.done = Number(p[1]); render.total = Number(p[2]); render.stage = 'rendering'; }
      if (/STAGE encoding/.test(line)) render.stage = 'encoding';
      if (/STAGE terrain/.test(line)) render.stage = 'terrain';
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', (b) => process.stderr.write(b));

  child.on('exit', (code) => {
    render.running = false;
    if (code === 0) {
      render.stage = 'done';
      render.file = '/out/hike.mp4?t=' + Date.now();
    } else {
      render.stage = 'failed';
      render.error = `renderer exited with code ${code}`;
    }
  });
}

let cache = null;
const hike = async (fresh) => (cache && !fresh ? cache : (cache = await buildHike()));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);

  try {
    if (path === '/api/hike') {
      const data = await hike(url.searchParams.has('fresh'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }

    // The frame renderer POSTs one PNG per frame; ffmpeg stitches them later.
    if (path === '/api/frame' && req.method === 'POST') {
      const n = url.searchParams.get('n');
      mkdirSync(join(ROOT, 'out', 'frames'), { recursive: true });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString();
      const m = /^data:image\/(png|jpeg);base64,/.exec(body);
      const ext = m?.[1] === 'png' ? 'png' : 'jpg';
      const img = Buffer.from(body.slice(m ? m[0].length : 0), 'base64');
      writeFileSync(join(ROOT, 'out', 'frames', `f${String(n).padStart(6, '0')}.${ext}`), img);
      res.writeHead(204);
      return res.end();
    }

    // One click renders the whole video. The work runs in headless Chrome via a
    // child process rather than in this tab, so it does not matter whether the
    // user stays on the page — Chrome would otherwise stop drawing the moment
    // they switched away.
    if (path === '/api/render' && req.method === 'POST') {
      if (render.running) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'already rendering' }));
      }
      startRender();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ started: true }));
    }

    if (path === '/api/render/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(render));
    }

    return serveStatic(path, res, req);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

function serveStatic(path, res, req) {
  let file;
  if (path === '/') file = join(ROOT, 'public', 'index.html');
  else if (path.startsWith('/vendor/')) file = join(ROOT, 'node_modules', path.slice(8));
  else if (path.startsWith('/.cache/')) file = join(ROOT, path.slice(1));
  else if (path.startsWith('/out/')) file = join(ROOT, path.slice(1));
  else if (existsSync(join(ROOT, 'public', path))) file = join(ROOT, 'public', path);
  else file = join(ROOT, path.slice(1));

  if (!resolve(file).startsWith(ROOT) || !existsSync(file)) {
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

server.listen(PORT, () => {
  console.log(`\n  hike-viewer  →  http://localhost:${PORT}\n`);
  hike(true)
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

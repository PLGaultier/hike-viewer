/* Hike Viewer — animates a GPX track over 3D terrain and renders it to video. */

const $ = (id) => document.getElementById(id);
const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const SAT = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

let hike, pts, map;
// Fixed preset. These were tuned on real tracks; the UI does not ask the user
// to choose, and render/record.mjs can still override them from the CLI.
const opts = { duration: 60, dwell: 4, exag: 1.0, pitch: 68, zoom: 14.2, res: 1080 };
const anim = { playing: false, t: 0, raf: null, last: 0, bearing: null };

/* ------------------------------------------------------------------ track */

// Track points arrive as packed arrays [lon, lat, ele, t, dist] to keep the
// payload small; unpack once into a shape the animation can index cheaply.
function unpack(raw) {
  return raw.map(([lon, lat, ele, t, dist]) => ({ lon, lat, ele, t, dist }));
}

// Position at a fraction of total *distance*. Driving the animation by distance
// rather than by clock time matters: this hike has 15 recording gaps (one of
// 69 minutes), and a time-driven camera would sit frozen through every one.
function sampleAt(progress) {
  const target = progress * pts[pts.length - 1].dist;
  let lo = 0, hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].dist < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a = pts[i - 1], b = pts[i];
  const span = b.dist - a.dist;
  const f = span === 0 ? 0 : (target - a.dist) / span;
  return {
    lon: a.lon + (b.lon - a.lon) * f,
    lat: a.lat + (b.lat - a.lat) * f,
    ele: a.ele + (b.ele - a.ele) * f,
    t: a.t + (b.t - a.t) * f,
    dist: target,
    index: i,
  };
}

const bearingBetween = (a, b) => {
  const y = Math.sin((b.lon - a.lon) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180);
  const x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) -
            Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lon - a.lon) * Math.PI / 180);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

// Raw GPS heading jitters badly when standing still. Look ~90m ahead for a
// stable direction, then damp what is left so the camera does not twitch.
function headingAt(progress) {
  const total = pts[pts.length - 1].dist;
  const ahead = Math.min(1, progress + 90 / total);
  const raw = bearingBetween(sampleAt(progress), sampleAt(ahead));
  if (anim.bearing === null) return (anim.bearing = raw);
  let delta = ((raw - anim.bearing + 540) % 360) - 180;   // shortest way round
  anim.bearing = (anim.bearing + delta * 0.06 + 360) % 360;
  return anim.bearing;
}

/* --------------------------------------------------------------- timeline */

// The video is a sequence of travel legs separated by a hold on each photo.
let timeline = [];

function buildTimeline() {
  const stops = hike.photos.map((p) => p.progress).sort((a, b) => a - b);

  // Hold on every photo, but never let the stops eat the walk: with a dozen
  // photos a fixed 4s each would be most of the video. Cap the total time spent
  // holding at 40% and share it out.
  const hold = stops.length
    ? Math.min(opts.dwell, (opts.duration * 0.4) / stops.length)
    : opts.dwell;
  const travel = Math.max(5, opts.duration - stops.length * hold);
  timeline = [];
  let from = 0, clock = 0;

  const leg = (a, b) => {
    const d = travel * (b - a);
    timeline.push({ kind: 'travel', start: clock, end: clock + d, from: a, to: b });
    clock += d;
  };

  stops.forEach((s, i) => {
    leg(from, s);
    timeline.push({ kind: 'hold', start: clock, end: clock + hold, at: s, photo: i });
    clock += hold;
    from = s;
  });
  leg(from, 1);
  return clock;
}

const totalDuration = () => timeline[timeline.length - 1].end;

// Maps video time onto {progress, photo being held, how far into the hold}.
function stateAt(time) {
  const seg = timeline.find((s) => time >= s.start && time <= s.end) ?? timeline[timeline.length - 1];
  if (seg.kind === 'hold') {
    return { progress: seg.at, photo: hike.photos[seg.photo], phase: (time - seg.start) / (seg.end - seg.start) };
  }
  const f = seg.end === seg.start ? 1 : (time - seg.start) / (seg.end - seg.start);
  // Ease each leg so departures and arrivals at photo stops are not abrupt.
  const eased = f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
  return { progress: seg.from + (seg.to - seg.from) * eased, photo: null, phase: 0 };
}

/* -------------------------------------------------------------------- map */

async function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    // Required so the canvas can be read back for frame-by-frame capture.
    preserveDrawingBuffer: true,
    antialias: true,
    attributionControl: false,
    maxPitch: 85,
    center: [pts[0].lon, pts[0].lat],
    zoom: opts.zoom,
    pitch: opts.pitch,
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [SAT], tileSize: 256, maxzoom: 18,
               attribution: 'Imagery © Esri' },
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 15,
               encoding: 'terrarium', attribution: 'Elevation © Mapzen / AWS' },
      },
      layers: [
        { id: 'sky', type: 'background', paint: { 'background-color': '#cfdcea' } },
        { id: 'sat', type: 'raster', source: 'sat' },
      ],
      sky: {
        'sky-color': '#3d7ec4',
        'horizon-color': '#dbe7f2',
        'sky-horizon-blend': 0.7,
        'atmosphere-blend': 0.8,
      },
    },
  });

  await new Promise((r) => map.on('load', r));

  map.setTerrain({ source: 'dem', exaggeration: opts.exag });

  // Whole route, dimmed — gives the viewer the shape of the day up front.
  map.addSource('route', { type: 'geojson', data: lineOf(0, 1) });
  map.addLayer({ id: 'route', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ffffff',
      'line-opacity': 0.45,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 14, 3, 16, 5],
    } });

  // The part already walked, drawn bright on top.
  map.addSource('trail', { type: 'geojson', data: lineOf(0, 0) });
  map.addLayer({ id: 'trail-glow', type: 'line', source: 'trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ff6b35', 'line-opacity': 0.45, 'line-blur': 10,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 9, 14, 18, 16, 26],
    } });
  map.addLayer({ id: 'trail', type: 'line', source: 'trail',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#ff6b35',
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 5, 16, 8],
    } });

  map.addSource('here', { type: 'geojson', data: pointOf(pts[0]) });
  map.addLayer({ id: 'here-halo', type: 'circle', source: 'here',
    paint: {
      'circle-color': '#ff6b35', 'circle-opacity': 0.3, 'circle-blur': 0.45,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 12, 14, 22, 16, 32],
    } });
  map.addLayer({ id: 'here', type: 'circle', source: 'here',
    paint: {
      'circle-color': '#ffffff', 'circle-stroke-color': '#ff6b35',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 5, 14, 8, 16, 11],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 14, 3.5, 16, 5],
    } });

  // Markers where photos sit, so they are visible before you reach them.
  map.addSource('shots', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: hike.photos.map((p) => pointOf(p)) },
  });
  map.addLayer({ id: 'shots', type: 'circle', source: 'shots',
    paint: {
      'circle-color': '#ffd166', 'circle-stroke-color': 'rgba(0,0,0,.6)',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 14, 6.5, 16, 9],
      'circle-stroke-width': 2,
    } });
}

const pointOf = (p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });

function lineOf(fromProgress, toProgress) {
  const total = pts[pts.length - 1].dist;
  const coords = pts
    .filter((p) => p.dist >= fromProgress * total && p.dist <= toProgress * total)
    .map((p) => [p.lon, p.lat]);
  if (coords.length < 2) coords.push(coords[0] ?? [pts[0].lon, pts[0].lat]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
}

/* ------------------------------------------------------------ render loop */

const LOOK_BACK = 1300;     // metres of trail behind the camera to consider
const MAX_DUCK = 34;        // most degrees of pitch we will give up

// Chase camera that will not fly through a mountain.
//
// Descending into the gorge, the camera trails below the ridge just crossed and
// ends up inside the terrain mesh, which renders as smeared backfaces. Terrain
// exaggeration makes it worse by multiplying every height: at 1.5x a 3539 m
// ridge is drawn at 5309 m.
//
// The correction is derived entirely from the GPX profile rather than from the
// map. map.queryTerrainElevation and transform.getCameraPosition both depend on
// which DEM tiles happen to be loaded — the former returns 0 without them, the
// latter reported 4949 m before tiles and 5566 m after for the same camera. A
// frame renderer cannot have its framing depend on network timing, so we use
// the one source of truth that is always fully loaded: the track itself.
function placeCamera(here, bearing, basePitch, baseZoom) {
  // How much higher than the hiker the ground behind rises. That ground is what
  // the camera would otherwise be buried in.
  let highest = here.ele;
  for (let i = here.index; i > 0 && here.dist - pts[i].dist < LOOK_BACK; i--) {
    if (pts[i].ele > highest) highest = pts[i].ele;
  }
  const rise = (highest - here.ele) * opts.exag;

  // Flattening the pitch swings the camera up and over that ground. ~25 m of
  // rise per degree matches the camera geometry at these zooms closely enough.
  const duck = Math.min(MAX_DUCK, rise / 25);

  map.jumpTo({
    center: [here.lon, here.lat],
    bearing,
    pitch: Math.max(24, basePitch - duck),
    // Pull back a little as we flatten, so the hiker does not fill the frame.
    zoom: baseZoom - duck * 0.012,
    // Pushes the hiker into the lower third instead of dead centre.
    padding: { top: map.getCanvas().clientHeight * 0.34, bottom: 0, left: 0, right: 0 },
  });
}

let ascentSoFar = 0;

function applyState(time) {
  const st = stateAt(time);
  const here = sampleAt(st.progress);

  // On a photo hold the camera keeps drifting slowly — a dead-still frame reads
  // as a freeze, a slow rotation reads as the hiker looking around.
  const drift = st.photo ? st.phase * 22 : 0;
  const bearing = st.photo ? (anim.bearing ?? 0) + drift : headingAt(st.progress);

  placeCamera(
    here, bearing,
    st.photo ? opts.pitch - 8 : opts.pitch,
    st.photo ? opts.zoom + 0.35 : opts.zoom
  );

  map.getSource('trail').setData(lineOf(0, st.progress));
  map.getSource('here').setData(pointOf(here));

  ascentSoFar = ascentUpTo(here.index);
  updateHud(here, st);
  return st;
}

// Cumulative ascent is recomputed from the start each frame; at 6k points this
// is cheap and avoids drift when scrubbing backwards.
function ascentUpTo(index) {
  let up = 0;
  for (let i = 1; i <= index && i < pts.length; i++) {
    const d = pts[i].ele - pts[i - 1].ele;
    if (d > 0) up += d;
  }
  return up;
}

let shownPhoto = null;

function updateHud(here, st) {
  $('statDist').textContent = (here.dist / 1000).toFixed(2);
  $('statEle').textContent = Math.round(here.ele);
  $('statAsc').textContent = Math.round(ascentSoFar);
  $('statTime').textContent = elapsed(here.t);
  $('barFill').style.width = `${(here.dist / pts[pts.length - 1].dist) * 100}%`;

  if (st.photo !== shownPhoto) {
    shownPhoto = st.photo;
    const card = $('photoCard');
    if (st.photo) {
      $('photoImg').src = st.photo.src;
      $('photoMeta').textContent =
        `${elapsed(st.photo.t)} in · ${Math.round(st.photo.ele)} m · km ${(st.photo.dist / 1000).toFixed(1)}`;
      card.classList.add('on');
    } else {
      card.classList.remove('on');
    }
  }
}

// Time into the hike, not time of day. A GPX records no timezone and there is
// no way to derive one from coordinates that is reliably right — longitude/15
// puts Kyrgyzstan an hour off what it observes. Elapsed time needs no guess and
// is never wrong.
let startTime = 0;
function elapsed(t) {
  const mins = Math.max(0, Math.round((t - startTime) / 60000));
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}`;
}

function tick(now) {
  if (!anim.playing) return;
  const dt = (now - anim.last) / 1000;
  anim.last = now;
  anim.t = Math.min(anim.t + dt, totalDuration());
  applyState(anim.t);
  if (anim.t >= totalDuration()) return stop();
  anim.raf = requestAnimationFrame(tick);
}

function play() {
  if (anim.t >= totalDuration()) anim.t = 0;
  anim.playing = true;
  anim.last = performance.now();
  $('btnPreview').textContent = 'Stop preview';
  anim.raf = requestAnimationFrame(tick);
}

function stop() {
  anim.playing = false;
  cancelAnimationFrame(anim.raf);
  $('btnPreview').textContent = 'Preview in browser';
}

function reset() {
  stop();
  anim.t = 0;
  anim.bearing = null;
  applyState(0);
}

/* ------------------------------------------------------------- compositor */

// The HUD is DOM for live preview, but video frames are assembled here so both
// capture paths produce identical output without a DOM-rasterising dependency.
const comp = document.createElement('canvas');
const cx = comp.getContext('2d');
const photoCache = new Map();

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`could not load ${src}`));
    im.src = src;
  });
}

const RESOLUTIONS = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };

function composite(st) {
  const canvas = map.getCanvas();
  const [W, H] = RESOLUTIONS[opts.res];
  if (comp.width !== W) { comp.width = W; comp.height = H; }

  // #stage is locked to 16:9 so the preview and the output frame the same view.
  cx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, W, H);

  const s = W / 1600;                       // scale HUD with output size
  const here = sampleAt(st.progress);

  cx.save();
  cx.shadowColor = 'rgba(0,0,0,.85)';
  cx.shadowBlur = 14 * s;

  const x = 30 * s, base = H - 34 * s;
  cx.fillStyle = 'rgba(255,255,255,.85)';
  cx.font = `600 ${15 * s}px ui-sans-serif, system-ui, sans-serif`;
  cx.fillText((hike.source.name || 'Hiking').toUpperCase(), x, base - 74 * s);

  const stats = [
    [(here.dist / 1000).toFixed(2), 'km'],
    [String(Math.round(here.ele)), 'm'],
    [String(Math.round(ascentSoFar)), 'm ↑'],
    [elapsed(here.t), 'local'],
  ];
  let sx = x;
  for (const [v, u] of stats) {
    cx.fillStyle = '#fff';
    cx.font = `650 ${34 * s}px ui-sans-serif, system-ui, sans-serif`;
    cx.fillText(v, sx, base - 30 * s);
    const w = cx.measureText(v).width;
    cx.fillStyle = 'rgba(255,255,255,.75)';
    cx.font = `${13 * s}px ui-sans-serif, system-ui, sans-serif`;
    cx.fillText(u, sx + w + 5 * s, base - 30 * s);
    sx += w + cx.measureText(u).width + 30 * s;
  }

  cx.shadowBlur = 0;
  const barW = W - 60 * s;
  cx.fillStyle = 'rgba(255,255,255,.22)';
  cx.fillRect(x, base - 16 * s, barW, 3 * s);
  cx.fillStyle = '#ff6b35';
  cx.fillRect(x, base - 16 * s, barW * (here.dist / pts[pts.length - 1].dist), 3 * s);
  cx.restore();

  if (st.photo) drawPhotoCard(st, s, W, H);
  return comp;
}

function drawPhotoCard(st, s, W, H) {
  const im = photoCache.get(st.photo.src);
  if (!im) return;

  // Match the DOM card's entrance: fade and settle over the first 18% of the hold.
  const a = Math.min(1, st.phase / 0.18) * Math.min(1, (1 - st.phase) / 0.18 + 0.001);
  const alpha = Math.max(0, Math.min(1, a));
  const cw = Math.min(W * 0.38, 460 * s);
  const ch = (cw / im.width) * im.height;
  const pad = 12 * s;
  const cardH = ch + pad + 32 * s;
  const cardX = W - cw - 44 * s - pad;
  const cardY = (H - cardH) / 2 + (1 - alpha) * 14 * s;

  cx.save();
  cx.globalAlpha = alpha;
  cx.shadowColor = 'rgba(0,0,0,.6)';
  cx.shadowBlur = 60 * s;
  cx.shadowOffsetY = 20 * s;
  cx.fillStyle = '#fff';
  cx.fillRect(cardX, cardY, cw + pad * 2, cardH);
  cx.shadowBlur = 0;
  cx.shadowOffsetY = 0;
  cx.drawImage(im, cardX + pad, cardY + pad, cw, ch);
  cx.fillStyle = '#333';
  cx.font = `${12 * s}px ui-sans-serif, system-ui, sans-serif`;
  cx.fillText(
    `${elapsed(st.photo.t)} in · ${Math.round(st.photo.ele)} m · km ${(st.photo.dist / 1000).toFixed(1)}`,
    cardX + pad + 2 * s, cardY + pad + ch + 20 * s
  );
  cx.restore();
}

// Decode every photo up front; a decode stalling mid-capture would drop frames.
async function warmPhotos() {
  await Promise.all(hike.photos.map(async (p) => {
    if (!photoCache.has(p.src)) photoCache.set(p.src, await loadImage(p.src));
  }));
}

/* ---------------------------------------------------------------- capture */

// Brief centred message over the map.
const flash = (msg) => {
  $('status').textContent = msg;
  $('status').classList.toggle('on', Boolean(msg));
};

// Blocks while the tab is in the background, telling the user why.
function visible() {
  if (document.visibilityState === 'visible') return Promise.resolve();
  flash('Bring this tab to the front — Chrome stops drawing in background tabs');
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', onChange);
      flash('Resuming…');
      resolve();
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

// Resolves once every tile for the current view has arrived and been painted.
//
// map.loaded() is not usable here: with terrain enabled it stays false
// indefinitely, which would make each frame burn its entire retry budget.
// areTilesLoaded() plus the 'idle' event reports the real state.
function settled(timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      map.off('idle', finish);
      clearTimeout(timer);
      // One more frame so the paint that follows the last tile is on the canvas.
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    };
    // Cap the wait so a single stuck tile cannot stall the whole render.
    const timer = setTimeout(finish, timeoutMs);
    if (map.areTilesLoaded()) return finish();
    map.on('idle', finish);
  });
}

/* ------------------------------------------------------------------- boot */

function renderPhotoList() {
  const ul = $('photoList');
  ul.innerHTML = '';
  for (const p of hike.photos) {
    const li = document.createElement('li');
    li.innerHTML =
      `<img src="${p.src}" alt="">` +
      `<div><div class="n">${p.file}</div>` +
      `<div class="d">km ${(p.dist / 1000).toFixed(2)} · ${Math.round(p.ele)} m · ${elapsed(p.t)}` +
      `${p.confidence === 'medium' || p.confidence === 'low'
          ? ` · <span class="bad">${p.confidence} confidence</span>` : ''}` +
      `${p.confidence === 'exact' ? ' · <span class="ok">GPS</span>' : ''}</div></div>`;
    li.title = p.note ?? 'Interpolated between two GPS fixes';
    li.onclick = () => { stop(); anim.t = timeAtProgress(p.progress); applyState(anim.t); };
    ul.appendChild(li);
  }
  for (const p of hike.rejected) {
    const li = document.createElement('li');
    li.innerHTML = `<div><div class="n">${p.file}</div><div class="d bad">${p.reason}</div></div>`;
    ul.appendChild(li);
  }
}

const timeAtProgress = (prog) => {
  const seg = timeline.find((s) => s.kind === 'hold' && Math.abs(s.at - prog) < 1e-9);
  return seg ? seg.start + (seg.end - seg.start) * 0.4 : 0;
};

function wireControls() {
  $('btnPreview').onclick = () => (anim.playing ? stop() : play());
  $('btnMake').onclick = makeVideo;
}

/* ------------------------------------------------------------ make video */

// Rendering happens in a headless Chrome the server launches, not in this tab.
// Chrome stops drawing in background tabs, so an in-page render would die the
// moment the user switched away — clicking a button and walking off is exactly
// what people do.
async function makeVideo() {
  stop();
  $('btnMake').disabled = true;
  $('btnMake').textContent = 'Rendering…';
  $('result').hidden = true;
  $('progress').hidden = false;
  setProgress(0, 'Starting…');

  const r = await fetch('/api/render', { method: 'POST' });
  if (!r.ok) return failMake((await r.json()).error ?? 'could not start');

  const poll = setInterval(async () => {
    const s = await (await fetch('/api/render/status')).json();

    if (s.stage === 'rendering' && s.total) {
      setProgress(s.done / s.total, `Rendering frame ${s.done} of ${s.total}`);
    } else if (s.stage === 'terrain') {
      setProgress(0.02, 'Loading terrain…');
    } else if (s.stage === 'encoding') {
      setProgress(0.97, 'Encoding video…');
    }

    if (s.running) return;
    clearInterval(poll);

    if (s.stage === 'done' && s.file) {
      setProgress(1, 'Done');
      $('progress').hidden = true;
      $('result').hidden = false;
      $('resultVideo').src = s.file;
      $('resultLink').href = s.file;
      $('resultLink').setAttribute('download', 'hike.mp4');
      $('btnMake').disabled = false;
      $('btnMake').textContent = 'Create video again';
    } else if (s.stage === 'failed') {
      failMake(s.error ?? 'render failed');
    }
  }, 1000);
}

// A finished video outlives the page session, so surface one that already
// exists instead of making the user render again to see it.
async function showExistingVideo() {
  try {
    const r = await fetch('/out/hike.mp4', { method: 'HEAD' });
    if (!r.ok) return;
    const src = '/out/hike.mp4?t=' + Date.now();
    $('resultVideo').src = src;
    $('resultLink').href = src;
    $('resultLink').setAttribute('download', 'hike.mp4');
    $('result').hidden = false;
    $('btnMake').textContent = 'Create video again';
  } catch {}
}

function setProgress(fraction, text) {
  $('pbarFill').style.width = `${Math.round(fraction * 100)}%`;
  $('progressText').textContent = text;
}

function failMake(message) {
  $('progress').hidden = true;
  $('btnMake').disabled = false;
  $('btnMake').textContent = 'Create video';
  flash(`Render failed — ${message}`);
}

(async function boot() {
  hike = await (await fetch('/api/hike')).json();
  if (hike.error) { $('summary').textContent = hike.error; return; }
  pts = unpack(hike.track.points);

  startTime = hike.track.stats.startTime;

  const s = hike.track.stats;
  $('hudTitle').textContent = hike.source.name || 'Hiking';
  $('summary').innerHTML =
    `${(s.distance / 1000).toFixed(1)} km · ${Math.round(s.ascent)} m ascent · ` +
    `${(s.duration / 3600000).toFixed(1)} h<br>` +
    `${Math.round(s.minEle)}–${Math.round(s.maxEle)} m`;

  renderPhotoList();
  buildTimeline();
  wireControls();
  showExistingVideo();
  await visible();
  flash('Loading terrain…');
  await initMap();
  await warmPhotos();
  applyState(0);
  // The first tiles over remote terrain take a few seconds; say so rather than
  // showing an unexplained black rectangle.
  await settled(15000);
  flash('Ready');
  setTimeout(() => flash(''), 1400);
})();

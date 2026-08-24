import { readFileSync } from 'node:fs';

// Minimal GPX trackpoint reader. Garmin exports are flat and predictable, so a
// targeted regex pass beats pulling in a full XML parser here.
const TRKPT = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>([\s\S]*?)<\/trkpt>/g;
const ELE = /<ele>([-\d.]+)<\/ele>/;
const TIME = /<time>([^<]+)<\/time>/;

export function parseGpx(path) {
  const xml = readFileSync(path, 'utf8');
  const name = xml.match(/<trk>[\s\S]*?<name>([^<]+)<\/name>/)?.[1]?.trim() ?? null;
  const points = [];

  for (const m of xml.matchAll(TRKPT)) {
    const [, lat, lon, body] = m;
    const ele = body.match(ELE);
    const time = body.match(TIME);
    points.push({
      lat: Number(lat),
      lon: Number(lon),
      ele: ele ? Number(ele[1]) : null,
      // GPX times are always UTC. Store epoch ms so every downstream comparison
      // happens on one absolute scale, never on wall-clock strings.
      t: time ? Date.parse(time[1]) : null,
    });
  }

  if (!points.length) {
    // Garmin Connect sometimes exports <trkseg/> with no points at all. Fail
    // loudly here rather than letting an empty track surface as a blank map.
    throw new Error(
      `${path} contains no track points. If this came from Garmin Connect, ` +
      `re-export it — an empty <trkseg/> means the export did not include GPS.`
    );
  }
  if (points.some((p) => p.t === null)) {
    throw new Error(`${path} has track points without <time>; photos cannot be placed.`);
  }

  points.sort((a, b) => a.t - b.t);
  return { name, ...withDerived(points) };
}

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Annotates each point with cumulative distance, then summarises the track.
function withDerived(points) {
  let dist = 0;
  let ascent = 0;
  let descent = 0;
  points[0].dist = 0;

  for (let i = 1; i < points.length; i++) {
    dist += haversine(points[i - 1], points[i]);
    points[i].dist = dist;
    const dEle = points[i].ele - points[i - 1].ele;
    if (dEle > 0) ascent += dEle;
    else descent -= dEle;
  }

  const eles = points.map((p) => p.ele);
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);

  return {
    points,
    stats: {
      count: points.length,
      distance: dist,
      ascent,
      descent,
      minEle: Math.min(...eles),
      maxEle: Math.max(...eles),
      startTime: points[0].t,
      endTime: points[points.length - 1].t,
      duration: points[points.length - 1].t - points[0].t,
      bounds: {
        west: Math.min(...lons), east: Math.max(...lons),
        south: Math.min(...lats), north: Math.max(...lats),
      },
    },
    gaps: findGaps(points),
  };
}

// A pause in recording (signal loss, auto-pause, a long lunch). Interpolating a
// photo across one of these is unreliable, so we surface them for the matcher.
const GAP_SECONDS = 120;

function findGaps(points) {
  const gaps = [];
  for (let i = 1; i < points.length; i++) {
    const seconds = (points[i].t - points[i - 1].t) / 1000;
    if (seconds > GAP_SECONDS) {
      gaps.push({ index: i - 1, from: points[i - 1].t, to: points[i].t, seconds });
    }
  }
  return gaps.sort((a, b) => b.seconds - a.seconds);
}

// Places a photo on the track by its capture instant.
//
// Straight linear interpolation is fine while the watch was recording steadily,
// but across a recording gap it invents a position on a straight line the hiker
// never walked. So inside a gap we snap to the nearest real sample and say so,
// rather than reporting a confident-looking lie.
export function placePhoto(photo, track) {
  const { points, stats, gaps } = track;

  // A photo that recorded its own position does not need to be inferred at all.
  // Phones stamp GPS; the Canon does not. Prefer the real fix when it is there.
  if (photo.exifGps) {
    const near = nearestPoint(points, photo.exifGps);
    return {
      ...photo,
      placed: true,
      confidence: 'exact',
      note: `Positioned from the photo's own GPS (${Math.round(near.metres)} m from the recorded track)`,
      lat: photo.exifGps.lat,
      lon: photo.exifGps.lon,
      ele: near.point.ele,
      dist: near.point.dist,
      progress: near.point.dist / stats.distance,
      elapsed: photo.t - stats.startTime,
    };
  }

  if (photo.t < stats.startTime || photo.t > stats.endTime) {
    const offBy = photo.t < stats.startTime
      ? stats.startTime - photo.t
      : photo.t - stats.endTime;
    return {
      ...photo,
      placed: false,
      reason: `Taken ${fmtDuration(offBy)} ${photo.t < stats.startTime ? 'before' : 'after'} the track` +
              (photo.offset ? ` (EXIF offset ${photo.offset})` : ' (no EXIF timezone offset recorded)'),
    };
  }

  let hi = lowerBound(points, photo.t);
  hi = Math.max(1, Math.min(hi, points.length - 1));
  const a = points[hi - 1];
  const b = points[hi];
  const spanMs = b.t - a.t;
  const gap = gaps.find((g) => photo.t > g.from && photo.t < g.to);

  let pos, confidence, note;
  if (gap) {
    // Snap to whichever end of the gap is closer in time.
    const nearer = photo.t - gap.from <= gap.to - photo.t ? a : b;
    pos = { lat: nearer.lat, lon: nearer.lon, ele: nearer.ele, dist: nearer.dist };
    const driftSec = Math.min(photo.t - gap.from, gap.to - photo.t) / 1000;
    // Close to a real sample the snap is effectively exact; deep inside a long
    // gap it is a guess and should be treated as one.
    confidence = driftSec < 60 ? 'high' : driftSec < 300 ? 'medium' : 'low';
    note = `Falls in a ${Math.round(gap.seconds)}s recording gap; snapped to the nearest fix ${Math.round(driftSec)}s away`;
  } else {
    const f = spanMs === 0 ? 0 : (photo.t - a.t) / spanMs;
    pos = {
      lat: a.lat + (b.lat - a.lat) * f,
      lon: a.lon + (b.lon - a.lon) * f,
      ele: a.ele + (b.ele - a.ele) * f,
      dist: a.dist + (b.dist - a.dist) * f,
    };
    confidence = 'high';
    note = null;
  }

  return {
    ...photo,
    placed: true,
    confidence,
    note,
    ...pos,
    progress: pos.dist / stats.distance,          // 0..1 along the trail
    elapsed: photo.t - stats.startTime,
  };
}

// Closest recorded track point to a coordinate, with the distance to it — used
// to read off elevation and how far along the route a GPS-tagged photo sits.
function nearestPoint(points, { lat, lon }) {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let point = points[0];
  for (const p of points) {
    const dx = (p.lon - lon) * kx;
    const dy = p.lat - lat;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) { best = d2; point = p; }
  }
  return { point, metres: Math.sqrt(best) * 111320 };
}

function lowerBound(points, t) {
  let lo = 0, hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

import exifr from 'exifr';
import { basename } from 'node:path';

// Reads the capture time as an absolute instant.
//
// The camera clock is not necessarily set to the timezone the hike happened in
// — an EOS R10 carried from Europe to Kyrgyzstan still stamps +02:00. So the
// EXIF *offset* is the only trustworthy way to reach UTC. We never assume the
// wall-clock reading is local to the track.
export async function readPhoto(path) {
  const exif = await exifr.parse(path, {
    pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'OffsetTime',
           'Orientation', 'Make', 'Model'],
    translateValues: false,
  });

  // Read GPS separately. Under translateValues:false the GPSLatitude tag comes
  // back as a raw [deg, min, sec] array, not a number — using it directly puts
  // the photo at NaN and silently pins it to the first track point.
  const gps = await exifr.gps(path).catch(() => null);

  if (!exif?.DateTimeOriginal) {
    throw new Error(`${basename(path)} has no EXIF DateTimeOriginal; cannot place it on the track.`);
  }

  const offset = exif.OffsetTimeOriginal ?? exif.OffsetTime ?? null;
  const t = toUtc(exif.DateTimeOriginal, offset);

  return {
    file: basename(path),
    t,
    offset,
    // Phones record a real fix; the Canon writes GPSVersionID and nothing else,
    // and those fall back to timestamp matching against the track.
    exifGps: Number.isFinite(gps?.latitude) && Number.isFinite(gps?.longitude)
      ? { lat: gps.latitude, lon: gps.longitude }
      : null,
    orientation: exif.Orientation ?? 1,
    camera: [exif.Make, exif.Model].filter(Boolean).join(' ') || null,
  };
}

// exifr hands back a Date built by interpreting the EXIF wall clock in the
// *host* timezone. We undo that, then re-apply the camera's own offset.
function toUtc(dateTimeOriginal, offset) {
  const d = dateTimeOriginal;
  const wallClockUtc = Date.UTC(
    d.getFullYear(), d.getMonth(), d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds()
  );
  if (!offset) return wallClockUtc; // no offset recorded: treat as UTC, flag upstream
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset.trim());
  if (!m) return wallClockUtc;
  const sign = m[1] === '-' ? -1 : 1;
  const minutes = sign * (Number(m[2]) * 60 + Number(m[3]));
  return wallClockUtc - minutes * 60000;
}

import sharp from 'sharp';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { heic as heicDecoder } from './env.js';

const CACHE = '.cache';
const WIDTH = 1600; // plenty for a photo card in a 1080p frame

// Full-resolution JPEGs (6000x4000, ~11MB) decode too slowly to composite while
// recording. Downscale once when the hike is first read and reuse on later runs.
//
// Returns the thumbnail's path *relative to `dir`* — every hike keeps its own
// .cache next to its own files, so the caller turns that into a URL.
export async function makeThumb(dir, file) {
  mkdirSync(join(dir, CACHE), { recursive: true });
  const src = join(dir, file);
  const out = join(dir, CACHE, thumbName(file));

  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
    return `${CACHE}/${thumbName(file)}`;
  }

  await sharp(await decodable(src, dir))
    .rotate()                       // applies the EXIF orientation tag
    .resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(out);

  return `${CACHE}/${thumbName(file)}`;
}

const thumbName = (file) => file.replace(/\.[^.]+$/, '') + '.jpg';

// sharp cannot open iPhone HEICs: libheif refuses them for having 48 references
// in the iref box against a hardening limit of 16. So they are transcoded to
// JPEG first by whatever this machine has — macOS decodes its own format with
// sips, everywhere else it is libheif's own CLI, which does not share sharp's
// hardening limit.
async function decodable(src, dir) {
  if (!/\.heic$/i.test(extname(src))) return src;

  const staged = join(dir, CACHE, '_' + thumbName(basename(src)));
  if (existsSync(staged) && statSync(staged).mtimeMs >= statSync(src).mtimeMs) return staged;

  const dec = heicDecoder();
  if (!dec.ok) {
    throw new Error(
      `HEIC needs an external decoder (sharp/libheif rejects iPhone files) and ` +
      `this machine has none. ${dec.hint}. Or convert the photo to JPEG first.`
    );
  }

  // Both write a JPEG to an explicit output path, they just spell it differently.
  const args = dec.tool === 'sips'
    ? ['-s', 'format', 'jpeg', src, '--out', staged]
    : [src, staged];

  try {
    execFileSync(dec.path, args, { stdio: 'ignore' });
  } catch (err) {
    throw new Error(`${dec.tool} could not decode this HEIC (${err.message}).`);
  }
  if (!existsSync(staged)) throw new Error(`${dec.tool} produced no output for this HEIC.`);
  return staged;
}

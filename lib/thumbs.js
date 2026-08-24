import sharp from 'sharp';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';

const CACHE = '.cache';
const WIDTH = 1600; // plenty for a photo card in a 1080p frame

// Full-resolution JPEGs (6000x4000, ~11MB) decode too slowly to composite while
// recording. Downscale once at startup and reuse on later runs.
export async function makeThumb(dir, file, orientation) {
  mkdirSync(join(dir, CACHE), { recursive: true });
  const src = join(dir, file);
  const out = join(dir, CACHE, file.replace(/\.[^.]+$/, '') + '.jpg');

  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
    return relThumb(file);
  }

  await sharp(await decodable(src, dir))
    .rotate()                       // applies the EXIF orientation tag
    .resize({ width: WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(out);

  return relThumb(file);
}

const relThumb = (file) => `/${CACHE}/${file.replace(/\.[^.]+$/, '')}.jpg`;

// sharp cannot open iPhone HEICs: libheif refuses them for having 48 references
// in the iref box against a hardening limit of 16. macOS decodes its own format
// natively, so hand those off to sips and let sharp take the JPEG.
async function decodable(src, dir) {
  if (!/\.heic$/i.test(extname(src))) return src;

  const staged = join(dir, CACHE, '_' + src.split('/').pop().replace(/\.[^.]+$/, '') + '.jpg');
  if (existsSync(staged) && statSync(staged).mtimeMs >= statSync(src).mtimeMs) return staged;

  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', staged], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'HEIC needs macOS sips to decode (sharp/libheif rejects iPhone files). ' +
      'Convert to JPEG first.'
    );
  }
  return staged;
}

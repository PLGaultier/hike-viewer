# Hike Viewer

Turns a GPX track plus the photos you took on the walk into an animated 3D
flyover video, Relive-style. It runs entirely on your own machine: your track
and your pictures are read from disk, rendered locally, and never uploaded
anywhere.

## Getting it running

**The only thing you need to install is [Node](https://nodejs.org)** — take the
version marked LTS. Everything else arrives with `npm install`.

Once Node is installed, **double-click the launcher for your machine** — it
installs what is missing the first time, then starts the app and opens your
browser. No typing.

| | |
|---|---|
| **macOS** | `start.command` |
| **Windows** | `start.bat` |

From a terminal, on any platform:

```bash
git clone <this repo> && cd hike-viewer
npm install        # also fetches ffmpeg and the Chromium that draws the frames
npm run doctor     # confirms this machine can render
npm start          # opens http://localhost:5173 in your browser
```

Then drag one `.gpx` and its photos onto the window. That is the whole
interface — there is nothing to configure.

### What `npm install` pulls down

| | |
|---|---|
| **Chromium** | ~500 MB — renders the frames |
| **ffmpeg** | ~45 MB — encodes them into an MP4 |

Both are ordinary npm packages, so there is no Homebrew, no `apt`, and no
`PATH` to configure. It is a few hundred megabytes and it happens once.
`npm run doctor` confirms what was found:

```
  ✓ Node          v24.4.0
  ✓ Chromium      ~/.cache/puppeteer/chrome/…
  ✓ ffmpeg        6.0  bundled with npm install
  ✓ HEIC decoder  sips  /usr/bin/sips
```

A GPU is not required, but without one Chrome falls back to software
rasterization and rendering is many times slower.

### Platforms

**macOS, Windows and Linux** all run the same code path — there is no separate
Windows procedure and no WSL. The encoder used to be a bash script, which was
the one thing a stock Windows machine could not run; it is a Node script now,
and Node is already there because it is what runs the app.

The one real difference is HEIC. macOS decodes it with `sips` and Linux with
libheif's `heif-convert`; **Windows has neither**, so iPhone `.HEIC` photos are
reported as unusable while JPEG and PNG work normally. Converting them to JPEG
first is the workaround.

The check marks and progress bar fall back to ASCII on Windows, since a console
that is not set to UTF-8 renders them as mojibake:

```
  [ok] ffmpeg        6.0  bundled with npm install
  Rendering  ############............   51%   920/1800 frames  ~2m left
```

## What you will see while it renders

A render takes a few minutes, and both the browser and the terminal say where
it is up to. The terminal looks like this:

```
  Rendering hike mta0vgkstr6l — this takes a few minutes. Keep this window open.
  Loading terrain — the first tiles of a new area take a moment…
  Rendering  ████████████░░░░░░░░░░░░   51%   920/1800 frames  ~2m left
  Encoding video…

  ✓ Done in 4m 29s  →  out/mta0vgkstr6l/hike.mp4
    It is playing in the browser now, and "Save video" downloads it.
```

Nothing needs to stay in front — the render happens in a Chrome of its own, not
in your tab — but the terminal window has to stay open, because that is the
process doing the work.

## Your first hike

Drag one `.gpx` and its photos anywhere onto the window. A folder of photos
works too — dropped directories are walked, so a camera import folder can go in
whole. There is also a **Drop or choose files…** button for the same thing.

For a photo to land on the track it needs a timestamp, which every camera and
phone writes by default. GPS in the photo is a bonus, not a requirement — see
[How photos land on the track](#how-photos-land-on-the-track).

The files are copied to `uploads/<id>/`, parsed, and the map swaps to the new
hike without a reload. Every hike you have dropped stays in the picker at the
top of the panel, so you can flip between them; **Delete** removes an upload and
its rendered video.

Click **Create video** and it renders to `out/<id>/hike.mp4`, then plays in the
page. Each hike renders to its own file, so one render never overwrites another,
and the page finds a hike's existing video when you switch back to it.

Dropping something unusable says why rather than failing quietly — no `.gpx` in
the drop, a second `.gpx` that was ignored, or photos that do not fall inside
the track's time window.

**Nothing leaves your machine.** Uploads and renders are `.gitignore`d, and so
are `*.gpx` and the usual image extensions, so your own files cannot be
committed by accident. A GPX is a precise record of where somebody walked; that
is also why there is no hosted version of this to try.

### Keeping a hike next to the code

The working folder itself counts as a hike, listed as *This folder*. Drop a
`.gpx` and some photos beside `server.js` and they show up on start without
going through the UI. It cannot be deleted from the panel — those files are
yours, not the app's.

## Why the render runs headless

Clicking the button does not render in your tab. The server launches a separate
headless Chrome and drives the animation there.

That is not incidental. Chrome stops running `requestAnimationFrame` in
background tabs and MapLibre draws on it, so an in-page render produces no
frames at all the moment you switch away — and clicking a button and then going
to do something else is exactly what people do. The headless Chrome is launched
with `--disable-renderer-backgrounding` and friends, so it renders unattended at
full speed. On an M-series Mac it uses the GPU (ANGLE Metal) at about 9 frames
per second at 1080p, so a 60-second video takes roughly three and a half
minutes. Without a usable GPU, Chrome falls back to software rasterization and
that figure gets much worse.

The **Preview in browser** button animates the map in the page, for a look
before committing to a render. That one does need the tab in front.

## Settings

There are none in the UI, on purpose. The preset is 60 seconds, 1080p, 30fps,
4 seconds held on each photo, true-to-life terrain relief. If you want
something else, the renderer takes flags:

```bash
npm run video -- --duration=90 --dwell=5 --res=1440 --fps=30
```

`npm run video -- --hike=<id>` picks a hike; without it the renderer takes
whatever the page would show by default.

Terrain this detailed does not compress cheaply — a 60s 1080p render lands
around 75 MB. `CRF=28 npm run mp4` re-encodes the existing frames at roughly a
third of that, and `CRF=20` gives an archival master at ~115 MB.
`render/to-mp4.mjs` reads `FRAMES=` and `OUT=` so it can be pointed at one
hike's frames.

## How photos land on the track

A photo that recorded its own GPS is placed there directly. Phones do; the Canon
writes `GPSVersionID` and no fix, so those are placed by matching capture time
against the track instead.

The catch is timezones. The camera stamps `OffsetTimeOriginal` from wherever its
clock was last set, *not* where the photo was taken. The Ala-Kul photos read
`08:17:47 +02:00` (European time) for a hike in Kyrgyzstan (UTC+6). So the
matcher converts EXIF time to UTC via the recorded offset and compares in UTC —
it never assumes the camera clock matches the hike's timezone.

If a photo lands outside the track's time window it is listed as rejected with
the reason, rather than being silently clamped onto the route.

Each placement carries a confidence: `exact` (the photo's own GPS), `high`
(interpolated between two nearby fixes), or `medium`/`low` (see gaps below).

**Recording gaps.** Interpolating across a pause in recording invents a position
on a straight line nobody walked. Photos falling inside a gap snap to the
nearest real fix and are labelled `medium` or `low` confidence by how far they
sat from one. The Ala-Kul track has 15 such gaps, the longest 69 minutes.

## HEIC

iPhone photos are read too, but sharp cannot open them: libheif rejects them for
carrying 48 references in the `iref` box against a hardening limit of 16. So
they are transcoded to JPEG first by whatever the machine has — `sips` on macOS,
which decodes the format natively, and libheif's own `heif-convert` elsewhere
(`sudo apt-get install libheif-examples`), which does not share sharp's
hardening limit. Windows has no equivalent, so HEIC is unsupported there. With
no decoder available, a HEIC is reported with that reason rather than ignored.

## The on-screen clock shows elapsed time

Not time of day. A GPX records no timezone and there is no way to derive one
from coordinates that is reliably right — longitude/15 puts Kyrgyzstan an hour
off what it actually observes. Elapsed time needs no guess and is never wrong,
so the HUD counts from the start of the hike.

## Output

Fixed 16:9 at 1080p; the in-page preview is locked to the same aspect so what
you see is what renders. Frames go to `out/<hike>/frames/` as JPEG and are
encoded to H.264 by `render/to-mp4.mjs`.

## The camera

A chase cam follows the hiker with a smoothed heading, and holds on each photo
with a slow drift so the stop doesn't read as a freeze.

Descending into the gorge it used to fly *through* the mountainside — the camera
trails below the ridge just crossed and ends up inside the terrain mesh, which
renders as smeared backfaces. `placeCamera` flattens the pitch to lift the
camera over whatever ground is behind it.

That correction is computed from the GPX elevation profile, not from the map:
`queryTerrainElevation` returns 0 when the DEM tiles under the query are not
cached, and `transform.getCameraPosition().altitude` reported 4949 m before
tiles and 5566 m after for the same camera. Framing that depends on network
timing is not acceptable in a frame renderer, so the correction uses the one
source that is always fully loaded — the track itself.

Terrain relief defaults to **1.0×**. Exaggeration multiplies every height, so at
1.5× a 3539 m ridge is drawn at 5309 m — which is what put ridges above the
camera in the first place.

## Map data

No API keys. Satellite imagery from Esri World Imagery, elevation from the
Mapzen/AWS Terrarium DEM (`maxzoom` 15). Both are fetched by the browser as you
pan, so the first load of a new area takes a moment.

## When something goes wrong

**macOS refuses to open `start.command`.** A file downloaded as a ZIP is
quarantined, so the first launch is blocked. Right-click it and choose *Open*,
which offers the same warning with an *Open* button. That is only needed once.

**Windows warns before running `start.bat`.** SmartScreen flags files that
arrive from the internet. Choose *More info* then *Run anyway*, once.

**`npm run doctor` fails on Chromium or ffmpeg.** The download was skipped or
interrupted — `npm install` again. For Chromium specifically,
`npx puppeteer browsers install chrome`. To use a browser you already have, set
`PUPPETEER_EXECUTABLE_PATH`; to use your own ffmpeg, set `FFMPEG`.

**The render fails immediately.** It checks for ffmpeg and Chromium before
drawing a single frame, and the panel shows what is missing — rather than
running ffmpeg after the last frame and losing the whole render to it.

**Chrome fails to launch on Linux.** In a container or as root the sandbox has
no user namespaces to work with; `--no-sandbox` and `--disable-dev-shm-usage`
are added automatically in those cases.

**A photo was rejected.** The panel gives the reason per file. Usually the
capture time falls outside the track's window — check that the camera's clock
and its `OffsetTimeOriginal` were right.

**The video is huge.** That is terrain detail, not a bug. `CRF=28 npm run mp4`
re-encodes it smaller without re-rendering.

## Layout

```
start.command       double-click launcher for macOS: installs, then starts
start.bat           the same for Windows
server.js           hike sessions, uploads, the API, launches renders
scripts/doctor.mjs  `npm run doctor` — is this machine able to render?
lib/env.js          what this machine has: ffmpeg, Chromium, a HEIC decoder
lib/gpx.js          GPX trackpoints, derived stats, recording gaps
lib/photos.js       EXIF capture time → UTC via the camera's own offset
lib/match.js        places a photo on the track, gap-aware
lib/thumbs.js       downscales photos (a 6000×4000 decode stutters mid-capture)
public/app.js       drop/upload, map, camera, timeline, frame compositor
render/record.mjs   headless Chrome driver, one hike per run
render/to-mp4.mjs   frames → H.264 MP4
```

A hike is just a directory holding one `.gpx` and some images: `uploads/<id>/`
for a dropped one, the repo root for *This folder*. Nothing else distinguishes
them, which is why the original single-hike path still works untouched.

Switching hikes tears the map down and builds a new one. Loading takes seconds
(GPX, then terrain tiles), so picking a second hike mid-load would otherwise run
two builds against the same globals — layers landing on the wrong map, an
orphaned canvas left stacked in the container holding a live WebGL context. Each
load takes a ticket and drops out as soon as a newer one exists.

Anything unplaceable is reported in the panel with the reason.

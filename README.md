# Hike Viewer

Local webapp that turns a GPX track plus timestamped photos into an animated 3D
flyover video, Relive-style. Files are read straight out of this folder.

```bash
npm install
npm start          # → http://localhost:5173
```

Click **Create video**. That's the whole interface — there is nothing to
configure. When it finishes the video plays in the page and lands in
`out/hike.mp4`.

Swapping hikes means dropping a different `.gpx` and photos in this folder and
restarting.

## Why the render runs headless

Clicking the button does not render in your tab. The server launches a separate
headless Chrome and drives the animation there.

That is not incidental. Chrome stops running `requestAnimationFrame` in
background tabs and MapLibre draws on it, so an in-page render produces no
frames at all the moment you switch away — and clicking a button and then going
to do something else is exactly what people do. The headless Chrome is launched
with `--disable-renderer-backgrounding` and friends, so it renders unattended at
full speed. On this machine it uses the GPU (ANGLE Metal) at about 9 frames per
second at 1080p.

The **Preview in browser** button animates the map in the page, for a look
before committing to a render. That one does need the tab in front.

## Settings

There are none in the UI, on purpose. The preset is 60 seconds, 1080p, 30fps,
4 seconds held on each photo, true-to-life terrain relief. If you want
something else, the renderer takes flags:

```bash
npm run video -- --duration=90 --dwell=5 --res=1440 --fps=30
```

Terrain this detailed does not compress cheaply — a 60s 1080p render lands
around 75 MB. `CRF=28 npm run mp4` re-encodes the existing frames at roughly a
third of that, and `CRF=20` gives an archival master at ~115 MB.

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
sat from one. This track has 15 such gaps, the longest 69 minutes.

## HEIC

iPhone photos are read too, but sharp cannot open them: libheif rejects them for
carrying 48 references in the `iref` box against a hardening limit of 16. macOS
decodes its own format natively, so those go through `sips` first. On anything
other than macOS a HEIC is reported with that reason rather than ignored.

## The on-screen clock shows elapsed time

Not time of day. A GPX records no timezone and there is no way to derive one
from coordinates that is reliably right — longitude/15 puts Kyrgyzstan an hour
off what it actually observes. Elapsed time needs no guess and is never wrong,
so the HUD counts from the start of the hike.

## Output

Fixed 16:9 at 1080p; the in-page preview is locked to the same aspect so what
you see is what renders. Frames go to `out/frames/` as JPEG and are encoded to
H.264 by `render/to-mp4.sh`.

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
Mapzen/AWS Terrarium DEM (`maxzoom` 15).

## Layout

```
server.js          reads the folder, serves the API, launches renders
lib/gpx.js         GPX trackpoints, derived stats, recording gaps
lib/photos.js      EXIF capture time → UTC via the camera's own offset
lib/match.js       places a photo on the track, gap-aware
lib/thumbs.js      downscales photos (a 6000×4000 decode stutters mid-capture)
public/app.js      map, camera, timeline, frame compositor
render/record.mjs  headless Chrome driver
render/to-mp4.sh   frames → H.264 MP4
```

Anything unplaceable is reported in the panel with the reason.

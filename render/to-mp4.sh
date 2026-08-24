#!/usr/bin/env bash
# Turns whatever the browser produced into a shareable MP4.
#
# Two possible inputs, in priority order:
#   out/frames/f000000.png…  from the HQ frame renderer  (preferred)
#   out/hike.webm            from the real-time recorder
set -euo pipefail

cd "$(dirname "$0")/.."
FPS="${FPS:-30}"
# Terrain this detailed is expensive to encode: crf 20 lands a 60s 1080p render
# at ~115MB, which is awkward to share. 23 is hard to tell apart in motion and
# roughly halves that. Override with CRF= for an archival master.
CRF="${CRF:-23}"
OUT="out/hike.mp4"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found. Install it with:  brew install ffmpeg" >&2
  exit 1
fi

# yuv420p + even dimensions keep the file playable in QuickTime, Photos, and
# anything that expects H.264 baseline-ish output rather than a browser codec.
COMMON=(-c:v libx264 -preset slow -crf "$CRF" -pix_fmt yuv420p
        -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart)

# The renderer writes .jpg; .png support stays for anything captured earlier.
EXT=""
compgen -G "out/frames/f*.jpg" > /dev/null && EXT="jpg"
[ -z "$EXT" ] && compgen -G "out/frames/f*.png" > /dev/null && EXT="png"

if [ -n "$EXT" ]; then
  COUNT=$(ls out/frames/f*."$EXT" | wc -l | tr -d ' ')
  echo "Encoding $COUNT frames at ${FPS}fps → $OUT"
  ffmpeg -y -framerate "$FPS" -i "out/frames/f%06d.$EXT" "${COMMON[@]}" "$OUT"
elif [ -f out/hike.webm ]; then
  echo "Transcoding out/hike.webm → $OUT"
  ffmpeg -y -i out/hike.webm "${COMMON[@]}" "$OUT"
else
  echo "Nothing to encode. Render a video in the browser first." >&2
  exit 1
fi

echo
echo "  $OUT  ($(du -h "$OUT" | cut -f1))"

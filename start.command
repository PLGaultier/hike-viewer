#!/usr/bin/env bash
# Double-click this to start Hike Viewer.
#
# macOS opens .command files in Terminal, so this is the whole interface for
# anyone who would rather not type commands: it installs what is missing the
# first time, then starts the app and opens the browser.

cd "$(dirname "$0")" || exit 1

echo
echo "  Hike Viewer"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node is not installed — it is what runs this app."
  echo
  echo "  Download the macOS installer from:  https://nodejs.org"
  echo "  Take the version marked LTS, run it, then double-click this file again."
  echo
  read -r -p "  Press return to close. "
  exit 1
fi

# First run: pull down the dependencies, including the bundled ffmpeg and the
# Chromium that draws the frames. It is a few hundred megabytes and only
# happens once, so say so rather than looking hung.
if [ ! -d node_modules ]; then
  echo "  First run — downloading what the app needs (a few hundred MB)."
  echo "  This happens once and takes a few minutes."
  echo
  if ! npm install; then
    echo
    echo "  That did not work. Check your internet connection and try again."
    read -r -p "  Press return to close. "
    exit 1
  fi
  echo
fi

npm run doctor || {
  echo
  read -r -p "  Press return to close. "
  exit 1
}

echo
echo "  Starting… your browser will open by itself."
echo "  Leave this window open while you use the app; close it to stop."
echo

npm start

# npm start only returns when the server stops, so this is the closing message.
echo
read -r -p "  Hike Viewer has stopped. Press return to close. "

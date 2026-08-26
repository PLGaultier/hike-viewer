@echo off
REM Double-click this to start Hike Viewer on Windows.
REM
REM The counterpart to start.command on macOS: it installs what is missing the
REM first time, then starts the app and opens the browser.

cd /d "%~dp0"

REM The app prints em-dashes and arrows. Without this a legacy console shows
REM them as mojibake; the check marks and progress bar already fall back to
REM ASCII on their own.
chcp 65001 >nul 2>&1

echo.
echo   Hike Viewer
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   Node is not installed - it is what runs this app.
  echo.
  echo   Download the Windows installer from:  https://nodejs.org
  echo   Take the version marked LTS, run it, then double-click this file again.
  echo.
  pause
  exit /b 1
)

REM First run: pull down the dependencies, including the bundled ffmpeg and the
REM Chromium that draws the frames. A few hundred megabytes, once.
if not exist node_modules (
  echo   First run - downloading what the app needs ^(a few hundred MB^).
  echo   This happens once and takes a few minutes.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   That did not work. Check your internet connection and try again.
    pause
    exit /b 1
  )
  echo.
)

call npm run doctor
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting... your browser will open by itself.
echo   Leave this window open while you use the app; close it to stop.
echo.

call npm start

echo.
pause

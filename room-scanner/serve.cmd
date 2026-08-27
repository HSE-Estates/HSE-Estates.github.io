@echo off
REM Serve the app on localhost. Scanning needs this: browsers only grant camera
REM and motion access on https or localhost, never on file://.
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  echo Serving on http://localhost:8123  --  Ctrl+C to stop
  start "" http://localhost:8123
  py -m http.server 8123
  goto :eof
)

where node >nul 2>nul
if %errorlevel%==0 (
  echo Serving on http://localhost:8123  --  Ctrl+C to stop
  start "" http://localhost:8123
  npx --yes serve -l 8123 .
  goto :eof
)

echo Neither Python nor Node was found on PATH.
echo Install either one, or host the folder on any static web host.
pause

@echo off
title CourtThread  -  keep this window open; close it to stop the app
cd /d "%~dp0app"

REM --- where the app keeps its database (next to this launcher, NOT bundled). ---
REM --- The app creates an empty one here on first run. Point this elsewhere to ---
REM --- use a database that lives on local storage instead.                     ---
if not exist "%~dp0data" mkdir "%~dp0data"
set "DB_PATH=%~dp0data\courtthread.db"

REM --- media folder: put your message-export folders (e.g. a Facebook export) in ---
REM --- here and the app finds their photos/videos automatically on any machine.  ---
if not exist "%~dp0media" mkdir "%~dp0media"
set "CT_MEDIA_DIRS=%~dp0media"

REM Port 3177 on purpose - NOT 3000 - so this can never collide with (or silently
REM open) a dev/main CourtThread server that is already running on the same PC.
set PORT=3177
set HOSTNAME=127.0.0.1
REM blank/generic export template (no names, photos, or presets)
set CT_GENERIC_TEMPLATE=1

REM refuse to start if something is already using our port
netstat -ano | findstr /r ":3177 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo  [X] Port 3177 is already in use - is another copy of CourtThread Portable
  echo      running? Close it first, then run this again.
  pause & exit /b 1
)

echo  CourtThread Portable is starting...
echo  It will open in your browser at  http://localhost:3177
echo.
echo  Keep this window open. Close it (or press Ctrl+C) to stop the app.
echo.

REM open the browser a few seconds after the server starts (runs in the background)
start "" cmd /c "ping -n 5 127.0.0.1 >nul & start "" http://localhost:3177"

"%~dp0node\node.exe" server.js

echo.
echo  CourtThread has stopped.
pause

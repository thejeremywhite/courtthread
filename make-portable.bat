@echo off
REM ============================================================================
REM  make-portable.bat  -  builds a self-contained, thumb-drive copy of the APP.
REM  Run this ONCE on a machine that has Node.js, with your dev server STOPPED.
REM  Output: CourtThread-Portable\  (app + private Node runtime + launcher).
REM  It bundles NO database, NO messages, and NO media - app only.
REM ============================================================================
setlocal enableextensions
cd /d "%~dp0"

set "NODE_VER=v22.13.1"
set "NODE_PKG=node-%NODE_VER%-win-x64"
set "OUT=%~dp0CourtThread-Portable"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is required to BUILD the portable app.
  echo     Install Node LTS from https://nodejs.org then re-run this.
  pause & exit /b 1
)

echo === [1/5] Installing dependencies ===
call npm install || ( echo [X] npm install failed & pause & exit /b 1 )

echo === [2/5] Building production app (standalone) ===
call npm run build || ( echo [X] build failed & pause & exit /b 1 )
if not exist ".next\standalone\server.js" (
  echo [X] standalone output missing - is  output: "standalone"  set in next.config.ts?
  pause & exit /b 1
)

echo === [3/5] Assembling portable folder ===
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%\app"
xcopy /e /i /q /y ".next\standalone\*" "%OUT%\app\" >nul
xcopy /e /i /q /y ".next\static\*"     "%OUT%\app\.next\static\" >nul
if exist "public" xcopy /e /i /q /y "public\*" "%OUT%\app\public\" >nul
REM --- strip the case-specific export template (Jessica/Waylon): use the blank/generic ---
REM --- chrome and remove the private preset photos + Jessica's custom swirl background. ---
set "PC=%OUT%\app\public\phone-chrome"
if exist "%PC%\generic-light.png" copy /y "%PC%\generic-light.png" "%PC%\light.png" >nul
if exist "%PC%\generic-dark.png"  copy /y "%PC%\generic-dark.png"  "%PC%\dark.png"  >nul
del /q "%PC%\generic-light.png" "%PC%\generic-dark.png" "%PC%\profile.png" "%PC%\profile-waylon.png" "%PC%\bg-light.png" "%PC%\bg-dark.png" 2>nul
REM sql.js loads a .wasm at runtime that output-tracing can miss - copy it explicitly
if exist "node_modules\sql.js\dist\sql-wasm.wasm" (
  if not exist "%OUT%\app\node_modules\sql.js\dist" mkdir "%OUT%\app\node_modules\sql.js\dist"
  copy /y "node_modules\sql.js\dist\sql-wasm.wasm" "%OUT%\app\node_modules\sql.js\dist\" >nul
)
mkdir "%OUT%\data"

echo === [4/5] Fetching private Node runtime (%NODE_VER%) ===
set "NODE_CACHE=%~dp0.node-cache"
if not exist "%NODE_CACHE%\%NODE_PKG%\node.exe" (
  if not exist "%NODE_CACHE%" mkdir "%NODE_CACHE%"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://nodejs.org/dist/%NODE_VER%/%NODE_PKG%.zip' -OutFile '%NODE_CACHE%\node.zip'" || ( echo [X] could not download portable Node & pause & exit /b 1 )
  powershell -NoProfile -Command "Expand-Archive -Force '%NODE_CACHE%\node.zip' '%NODE_CACHE%'"
  del "%NODE_CACHE%\node.zip"
)
mkdir "%OUT%\node"
copy /y "%NODE_CACHE%\%NODE_PKG%\node.exe" "%OUT%\node\" >nul

echo === [5/5] Adding launcher + readme ===
copy /y "%~dp0portable\Start CourtThread.bat" "%OUT%\" >nul
copy /y "%~dp0portable\READ ME FIRST.txt"     "%OUT%\" >nul

echo.
echo ============================================================================
echo  DONE.  Copy this whole folder to your thumb drive:
echo      %OUT%
echo  Then double-click  "Start CourtThread.bat"  on any 64-bit Windows PC.
echo  (No database/messages/media were bundled - app only.)
echo ============================================================================
pause

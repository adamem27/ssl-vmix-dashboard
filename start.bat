@echo off
rem Double-click on Windows: fetches the latest version, builds it and starts the dashboard.
cd /d "%~dp0"
echo == Checking for updates
for /f %%i in ('git rev-parse HEAD') do set BEFORE=%%i
git checkout -- package-lock.json 2>nul
git pull --ff-only || echo Could not update. Starting the current version.
for /f %%i in ('git rev-parse HEAD') do set AFTER=%%i
set REBUILD=0
if not "%BEFORE%"=="%AFTER%" set REBUILD=1
if not exist node_modules set REBUILD=1
if not exist server\dist\index.js set REBUILD=1
if not exist web\dist set REBUILD=1
if "%REBUILD%"=="1" (
  echo == Installing and building
  call npm install --no-audit --no-fund || goto :fail
  call npm run build || goto :fail
) else (
  echo == Already up to date
)
echo == Starting on http://localhost:4310 (close this window to stop)
start "" http://localhost:4310
call npm start
goto :eof
:fail
echo Build failed.
pause

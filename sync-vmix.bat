@echo off
rem Double-click on the vMix PC: copies images, ssl-vmix.xlsx and ssl-vmix.json from the online dashboard to a local folder.
cd /d "%~dp0"
git pull --ff-only >nul 2>&1
echo == vMix sync (close this window to stop)
node vmix-sync\vmix-sync.mjs
pause

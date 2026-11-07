@echo off
rem Runs on the vMix PC: keeps images, ssl-vmix.xlsx and ssl-vmix.json from the online dashboard in a local folder.
rem Restarts itself if it ever stops. Close this window to stop syncing.
cd /d "%~dp0"
title SSL vMix sync
where node >nul 2>&1 || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
if not exist vmix-sync\config.json node vmix-sync\vmix-sync.mjs --setup
:loop
git pull --ff-only >nul 2>&1
node vmix-sync\vmix-sync.mjs
echo Sync stopped, restarting in 5 s...
timeout /t 5 /nobreak >nul
goto loop

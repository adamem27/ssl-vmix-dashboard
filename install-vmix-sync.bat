@echo off
rem Run once on the vMix PC: asks for the dashboard address, password and folder,
rem then starts the sync now and at every Windows login (minimized window).
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
node vmix-sync\vmix-sync.mjs --setup || (pause & exit /b 1)
set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
> "%STARTUP%\SSL vMix sync.cmd" echo @start "SSL vMix sync" /min "%~dp0sync-vmix.bat"
echo Sync will start automatically at login.
start "SSL vMix sync" /min "%~dp0sync-vmix.bat"
echo Started. You can close this window.
pause

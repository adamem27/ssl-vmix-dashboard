@echo off
rem Stops starting the vMix sync at login.
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SSL vMix sync.cmd" 2>nul
echo Autostart removed. Close the "SSL vMix sync" window to stop the current sync.
pause

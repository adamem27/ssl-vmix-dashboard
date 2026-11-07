@echo off
rem Start the dashboard automatically (minimized) when Windows logs in.
> "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SSL Dashboard.cmd" echo @start "SSL Dashboard" /min "%~dp0SSL Dashboard.bat"
echo Autostart is ON.
pause

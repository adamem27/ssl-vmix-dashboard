@echo off
rem Double-click to start the SSL vMix dashboard (updates itself first).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
if errorlevel 1 pause

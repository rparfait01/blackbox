@echo off
title BLACK BOX Dev Server
echo Starting Stillpoint dev server...
echo.

cd /d C:\dev\BlackBox

start "" "http://localhost:5173"

pnpm -F pwa dev

pause

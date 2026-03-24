@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo Install Node.js LTS, then run this helper again.
  pause
  exit /b 1
)
echo Starting Owlbear Sync Music helper...
node server.js
if errorlevel 1 (
  echo.
  echo The helper stopped because of an error.
  pause
)

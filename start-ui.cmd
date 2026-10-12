@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install Node.js and try again.
  pause
  exit /b 1
)
set "AGENT_BRIDGE_NO_OPEN="
node start.js
echo.
echo Agent Bridge has stopped. Press any key to close this window.
pause >nul

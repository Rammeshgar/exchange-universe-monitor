@echo off
setlocal
pushd "%~dp0" || exit /b 1
where npm.cmd >nul 2>&1 || (echo Install Node.js 22 or later first. & pause & exit /b 1)
call npm ci --no-audit --no-fund
if errorlevel 1 goto failed
call npx playwright install chromium
if errorlevel 1 goto failed
popd
echo Setup complete. Open Start Dashboard.cmd to run the monitor.
pause
exit /b 0
:failed
popd
echo Setup failed. Review the error above before retrying.
pause
exit /b 1

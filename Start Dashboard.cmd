@echo off
setlocal
pushd "%~dp0" || exit /b 1
set "MONITOR_URL=http://127.0.0.1:4914/"
if not exist "node_modules\playwright\package.json" (
    echo Run Setup Monitor.cmd before opening the dashboard.
    pause
    popd
    exit /b 1
)
powershell -NoProfile -Command "try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:4914/api/status' -TimeoutSec 2; if ($null -eq $response.runs) { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process node.exe -WindowStyle Hidden -ArgumentList 'dashboard.cjs' -WorkingDirectory (Get-Location).Path -RedirectStandardOutput 'dashboard.stdout.log' -RedirectStandardError 'dashboard.stderr.log'"
    powershell -NoProfile -Command "for ($i = 0; $i -lt 12; $i++) { try { $response = Invoke-RestMethod -Uri 'http://127.0.0.1:4914/api/status' -TimeoutSec 1; if ($null -ne $response.runs) { exit 0 } } catch {}; Start-Sleep -Milliseconds 300 }; exit 1"
    if errorlevel 1 (
        echo The Exchange Universe dashboard could not start on port 4914.
        pause
        popd
        exit /b 1
    )
)
start "" "%MONITOR_URL%"
popd

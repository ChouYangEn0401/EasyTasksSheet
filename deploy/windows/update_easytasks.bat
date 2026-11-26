@echo off
rem ============================================================================
rem  EasyTasksSheet - update to the latest code and restart the service.
rem  Order: backup DB -> git pull --ff-only -> pip install -> build frontend
rem         -> restart service -> health check.
rem  Stops at the first failure; the service is NOT restarted if the build fails.
rem
rem  KEEP THIS FILE ASCII-ONLY (see setup_easytasks.bat).
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
set "SVC=easytasks"
set "PORT=8100"
set "PY=%APP_DIR%\.venv\Scripts\python.exe"
cd /d "%APP_DIR%"
if errorlevel 1 goto :end

echo === [1/5] Backup before updating ===
"%PY%" -m server.cli backup
if errorlevel 1 (
  echo [X] Backup failed, update stopped.
  goto :end
)

echo === [2/5] git pull ===
git status --porcelain --untracked-files=no | findstr . >nul
if not errorlevel 1 (
  echo [X] The working copy has uncommitted changes. Check with: git status
  goto :end
)
git pull --ff-only
if errorlevel 1 (
  echo [X] git pull failed.
  goto :end
)
git log -1 --format="  Now at: %%h %%ci %%s"

echo === [3/5] Python packages ===
"%PY%" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [X] pip install failed.
  goto :end
)

echo === [4/5] Frontend ===
echo   Static files under web\ - nothing to build.

echo === [5/5] Restart service ===
net stop "%SVC%"
net start "%SVC%"
timeout /t 5 /nobreak >nul
set "CODE=0"
for /f %%S in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:%PORT%/api/health).StatusCode } catch { 0 }"') do set "CODE=%%S"
if "!CODE!"=="200" (
  echo [OK] Update done, /api/health returned 200.
) else (
  echo [X] /api/health returned !CODE!. See logs\easytasks.err.log
)

:end
echo.
pause
endlocal
exit /b


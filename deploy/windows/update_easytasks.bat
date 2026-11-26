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

echo === [4/5] Build frontend ===
call :ensure_node
if errorlevel 1 goto :end
call npm ci
if errorlevel 1 (
  echo [X] npm ci failed. Service not restarted.
  goto :end
)
call npm run build
if errorlevel 1 (
  echo [X] npm run build failed. Service not restarted.
  goto :end
)

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

rem ---------------------------------------------------------------------------
rem :ensure_node - same as in setup_easytasks.bat
rem ---------------------------------------------------------------------------
:ensure_node
set "NODE_DIR=%APP_DIR%\.tools\node"
set "SYS_NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ('node -v 2^>nul') do set "SYS_NODE_MAJOR=%%V"
if defined SYS_NODE_MAJOR set "SYS_NODE_MAJOR=!SYS_NODE_MAJOR:v=!"
if defined SYS_NODE_MAJOR if !SYS_NODE_MAJOR! GEQ 22 (
  where npm >nul 2>&1
  if not errorlevel 1 exit /b 0
)
if defined SYS_NODE_MAJOR echo   System Node v!SYS_NODE_MAJOR! is older than 22, using portable Node.js 22 instead.
if exist "%NODE_DIR%\npm.cmd" goto :ensure_node_path
echo   npm not found: downloading portable Node.js 22 into %NODE_DIR%
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ensure-node.ps1" -ProjectDir "%APP_DIR%"
if errorlevel 1 (
  echo [X] Node.js download failed. Check that this machine can reach nodejs.org.
  exit /b 1
)
if not exist "%NODE_DIR%\npm.cmd" (
  echo [X] %NODE_DIR%\npm.cmd not found after download.
  exit /b 1
)
:ensure_node_path
set "PATH=%NODE_DIR%;%PATH%"
exit /b 0

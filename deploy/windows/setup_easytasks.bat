@echo off
rem ============================================================================
rem  EasyTasksSheet - first-time setup (or rebuild) of the program environment.
rem  Does: create .venv -> pip install -> create .env (kept if it exists)
rem        -> build frontend -> create data / logs / backups folders.
rem  Does NOT register or stop any service.
rem  Needs: Python 3.11+ (installed for all users). Node.js is optional: if npm
rem  is missing or older than v22, a portable Node.js 22 is downloaded into
rem  <project>\.tools\node (used only to build the frontend).
rem
rem  KEEP THIS FILE ASCII-ONLY. cmd.exe misreads UTF-8 files after call/goto
rem  (it jumps to the wrong byte offset), which breaks the script.
rem  See server/tests/test_deploy_scripts.py.
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
rem Project root = two folders up from this script (works wherever it is cloned)
set "SCRIPT_DIR=%~dp0"
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"

if not exist "%APP_DIR%\main.py" (
  echo [X] %APP_DIR%\main.py not found. Run this script from the project's deploy\windows folder.
  goto :end
)
cd /d "%APP_DIR%"

echo === [1/4] Python environment ===
if not exist ".venv\Scripts\python.exe" (
  py -3.11 -m venv .venv 2>nul || py -3 -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo [X] Could not create .venv. Install Python 3.11+ with the py launcher.
    goto :end
  )
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [X] pip install failed.
  goto :end
)
".venv\Scripts\python.exe" --version

echo === [2/4] .env ===
if exist ".env" (
  echo   .env already exists, not overwritten.
) else (
  copy /Y "deploy\windows\env.152.example" ".env" >nul
  echo   Created .env from deploy\windows\env.152.example. Check BACKUP_DIR in Notepad.
)

echo === [3/4] Build frontend - reads BASE_PATH from .env ===
call :ensure_node
if errorlevel 1 goto :end
call npm ci
if errorlevel 1 (
  echo [X] npm ci failed.
  goto :end
)
call npm run build
if errorlevel 1 (
  echo [X] npm run build failed.
  goto :end
)
if not exist "dist\web\index.html" (
  echo [X] Build finished but dist\web\index.html is missing.
  goto :end
)
echo   [OK] dist\web\index.html built.

echo === [4/4] Folders ===
if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"
if not exist "backups" mkdir "backups"
echo.
echo DONE. Next: deploy\windows\install_easytasks_service.bat check

:end
echo.
pause
endlocal
exit /b

rem ---------------------------------------------------------------------------
rem :ensure_node - make npm available.
rem   System Node v22+ on PATH -> use it.
rem   Otherwise use (or download) the portable Node.js 22 in .tools\node.
rem   Kept outside any ( ... ) block so a PATH containing "(x86)" cannot break parsing.
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
echo   - for building this project only; no installer, no system changes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ensure-node.ps1" -ProjectDir "%APP_DIR%"
if errorlevel 1 (
  echo [X] Node.js download failed. Check that this machine can reach nodejs.org,
  echo     or install Node.js 22 LTS manually, reopen cmd and run this again.
  exit /b 1
)
if not exist "%NODE_DIR%\npm.cmd" (
  echo [X] %NODE_DIR%\npm.cmd not found after download.
  exit /b 1
)
:ensure_node_path
set "PATH=%NODE_DIR%;%PATH%"
exit /b 0

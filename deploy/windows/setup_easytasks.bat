@echo off
rem ============================================================================
rem  EasyTasksSheet - first-time setup (or rebuild) of the program environment.
rem  Does: create .venv -> pip install -> create .env (kept if it exists)
rem        -> create data / logs / backups folders.
rem  Does NOT register or stop any service.
rem  Needs: Python 3.11+ (installed for all users). Nothing else: the frontend
rem  is plain static files under <project>\web (no Node.js, no build step).
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

echo === [3/4] Frontend ===
echo   Static files under web\ - nothing to build.

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


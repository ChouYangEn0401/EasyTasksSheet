@echo off
rem ============================================================================
rem  EasyTasksSheet - turn on "restore unlock" on THIS machine.
rem  While it is on (30 minutes, or until one restore is done), a root user can
rem  replace ALL data with a site pack (.etpack) from the web page
rem  (Data management -> Site pack). Remote users cannot turn this on, which is
rem  what protects a server that already has data.
rem  Usage (administrator cmd):
rem    allow_restore.bat            unlock for 30 minutes
rem    allow_restore.bat revoke     turn it off now
rem
rem  KEEP THIS FILE ASCII-ONLY (see setup_easytasks.bat).
rem ============================================================================
setlocal EnableExtensions
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
cd /d "%APP_DIR%"
if errorlevel 1 goto :end
if not exist ".venv\Scripts\python.exe" (
  echo [X] .venv not found. Run deploy\windows\setup_easytasks.bat first.
  goto :end
)
if /i "%~1"=="revoke" (
  ".venv\Scripts\python.exe" -m server.cli allow-restore --revoke
) else (
  ".venv\Scripts\python.exe" -m server.cli allow-restore
)

:end
echo.
pause
endlocal
exit /b

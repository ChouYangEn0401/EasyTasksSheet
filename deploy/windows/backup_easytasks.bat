@echo off
rem ============================================================================
rem  EasyTasksSheet - back up the database and attachments.
rem  For Windows Task Scheduler (daily), can also be run by hand.
rem  Location and count: BACKUP_DIR / BACKUP_KEEP in .env. Output: logs\backup.log
rem  No need to stop the service (online SQLite backup). No pause, so the
rem  scheduled task never hangs.
rem  Register the scheduled task (administrator cmd, daily 03:17, SYSTEM):
rem    schtasks /Create /TN "EasyTasksSheet Backup" /TR "<project>\deploy\windows\backup_easytasks.bat" /SC DAILY /ST 03:17 /RU SYSTEM /F
rem  Run it once now: schtasks /Run /TN "EasyTasksSheet Backup"
rem
rem  KEEP THIS FILE ASCII-ONLY (see setup_easytasks.bat).
rem ============================================================================
setlocal EnableExtensions
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
cd /d "%APP_DIR%"
if errorlevel 1 exit /b 1
if not exist "logs" mkdir "logs"
set "PYTHONIOENCODING=utf-8"
echo ==== %DATE% %TIME% ==== >> "logs\backup.log"
"%APP_DIR%\.venv\Scripts\python.exe" -m server.cli backup >> "logs\backup.log" 2>&1
set "RC=%ERRORLEVEL%"
echo exit code %RC% >> "logs\backup.log"
endlocal & exit /b %RC%

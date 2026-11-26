@echo off
rem ============================================================================
rem  EasyTasksSheet - create (or re-create) the NSSM Windows service "easytasks".
rem  Usage (administrator cmd):
rem    install_easytasks_service.bat check   check only, change nothing
rem    install_easytasks_service.bat         check -> type YES -> stop and remove
rem                                          the old service -> create -> start -> verify
rem  Does NOT create .venv, install packages, build the frontend or copy .env
rem  (that is setup_easytasks.bat), and never deletes any folder.
rem
rem  KEEP THIS FILE ASCII-ONLY (see setup_easytasks.bat).
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
rem ---- settings ----
set "SVC=easytasks"
set "PORT=8100"
set "NSSM=C:\nssm\win64\nssm.exe"
rem ------------------
set "PY=%APP_DIR%\.venv\Scripts\python.exe"
set "LOGDIR=%APP_DIR%\logs"
set "MODE=%~1"

echo.
echo === [1/4] Pre-checks ===
set "ERR=0"
if not exist "%NSSM%" call :fail "NSSM not found: %NSSM%"
if not exist "%APP_DIR%\main.py" call :fail "%APP_DIR%\main.py not found"
if not exist "%PY%" call :fail "%PY% not found - run setup_easytasks.bat first"
if not exist "%APP_DIR%\.env" call :fail "%APP_DIR%\.env not found - run setup_easytasks.bat first"
if not exist "%APP_DIR%\web\index.html" call :fail "web\index.html not found - the project folder is incomplete"
if exist "%APP_DIR%\.env" call :checkenv "HOST=127.0.0.1"
if exist "%APP_DIR%\.env" call :checkenv "PORT=%PORT%"
if exist "%APP_DIR%\.env" call :checkenv "BASE_PATH=/easytasks"
if exist "%APP_DIR%\.env" call :checkenv "NODE_ENV=production"
if exist "%APP_DIR%\.env" call :checkenv "TRUSTED_PROXY=true"
sc query "%SVC%" >nul 2>&1
if errorlevel 1 goto :no_old_service
echo   Service %SVC% exists. Current settings:
"%NSSM%" get %SVC% Application
"%NSSM%" get %SVC% AppDirectory
"%NSSM%" get %SVC% AppParameters
goto :checks_done
:no_old_service
echo   Service %SVC% does not exist yet, it will be created.
netstat -ano | findstr /R /C:"127.0.0.1:%PORT% .*LISTENING" /C:"0.0.0.0:%PORT% .*LISTENING" >nul
if not errorlevel 1 call :fail "port %PORT% is already used by another program - check: netstat -ano | findstr :%PORT%"
:checks_done
if "%ERR%"=="1" (
  echo.
  echo There were errors. Nothing was changed.
  goto :end
)
echo   All checks passed.

if /i "%MODE%"=="check" (
  echo.
  echo check mode: nothing was changed.
  goto :end
)

echo.
echo The old %SVC% service, if any, will be stopped and removed, then created again
echo and started. Data in %APP_DIR%\data is not touched.
set "ANS="
set /p "ANS=Type YES to continue: "
if not "!ANS!"=="YES" (
  echo Cancelled. Nothing was changed.
  goto :end
)

echo.
echo === [2/4] Stop and remove the old service ===
sc query "%SVC%" >nul 2>&1
if errorlevel 1 (
  echo   No old service.
  goto :create
)
net stop "%SVC%" >nul 2>&1
sc query "%SVC%" | findstr /C:"STOPPED" >nul
if errorlevel 1 (
  echo   [X] %SVC% did not stop. Do not use taskkill /f; check %LOGDIR%\easytasks.err.log
  goto :end
)
"%NSSM%" remove "%SVC%" confirm

:create
echo.
echo === [3/4] Create the service ===
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
"%NSSM%" install "%SVC%" "%PY%"
"%NSSM%" set "%SVC%" AppParameters "main.py"
"%NSSM%" set "%SVC%" AppDirectory "%APP_DIR%"
"%NSSM%" set "%SVC%" DisplayName "EasyTasksSheet Web Service"
"%NSSM%" set "%SVC%" Description "EasyTasksSheet behind nginx /easytasks/, 127.0.0.1:%PORT%"
"%NSSM%" set "%SVC%" Start SERVICE_AUTO_START
"%NSSM%" set "%SVC%" AppEnvironmentExtra PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
"%NSSM%" set "%SVC%" AppStdout "%LOGDIR%\easytasks.out.log"
"%NSSM%" set "%SVC%" AppStderr "%LOGDIR%\easytasks.err.log"
"%NSSM%" set "%SVC%" AppRotateFiles 1
"%NSSM%" set "%SVC%" AppRotateBytes 10485760
"%NSSM%" set "%SVC%" AppExit Default Restart
"%NSSM%" set "%SVC%" AppRestartDelay 5000
net start "%SVC%"

echo.
echo === [4/4] Verify ===
timeout /t 5 /nobreak >nul
sc query "%SVC%" | findstr /C:"RUNNING" >nul
if errorlevel 1 (echo   [X] Service is not RUNNING) else (echo   [OK] Service RUNNING)
netstat -ano | findstr /R /C:"0.0.0.0:%PORT% .*LISTENING" >nul
if not errorlevel 1 echo   [X] Port %PORT% is bound to 0.0.0.0 - HOST in .env must be 127.0.0.1
netstat -ano | findstr /R /C:"127.0.0.1:%PORT% .*LISTENING" >nul
if errorlevel 1 (echo   [X] Nothing listening on 127.0.0.1:%PORT%) else (echo   [OK] Listening on 127.0.0.1:%PORT%)
set "CODE=0"
for /f %%S in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:%PORT%/api/health).StatusCode } catch { 0 }"') do set "CODE=%%S"
if "!CODE!"=="200" (echo   [OK] /api/health returned 200) else (echo   [X] /api/health returned !CODE!)
echo   --- last 15 lines of the logs ---
powershell -NoProfile -Command "foreach ($f in '%LOGDIR%\easytasks.out.log','%LOGDIR%\easytasks.err.log') { if (Test-Path $f) { Get-Content $f -Tail 15 -Encoding UTF8 } }"
echo.
echo Next: add deploy\windows\nginx-easytasks.conf to C:\nginx\conf\nginx.conf,
echo run nginx -t, reload, then open https://140.112.180.152/easytasks/ from campus.
goto :end

:fail
echo   [X] %~1
set "ERR=1"
exit /b 0

:checkenv
findstr /B /C:"%~1" "%APP_DIR%\.env" >nul
if errorlevel 1 call :fail ".env has no line: %~1"
exit /b 0

:end
echo.
pause
endlocal
exit /b

@echo off
rem ============================================================================
rem  EasyTasksSheet - stop and remove the Windows service "easytasks".
rem  Does not delete any folder or data, and never force-kills the process.
rem  To register it again: install_easytasks_service.bat
rem
rem  KEEP THIS FILE ASCII-ONLY (see setup_easytasks.bat).
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
set "SVC=easytasks"
set "NSSM=C:\nssm\win64\nssm.exe"

sc query "%SVC%" >nul 2>&1
if errorlevel 1 (
  echo Service %SVC% does not exist. Nothing to do.
  goto :end
)
"%NSSM%" get %SVC% Application
"%NSSM%" get %SVC% AppDirectory
set "ANS="
set /p "ANS=Type YES to stop and remove %SVC%: "
if not "!ANS!"=="YES" (
  echo Cancelled.
  goto :end
)
net stop "%SVC%"
sc query "%SVC%" | findstr /C:"STOPPED" >nul
if errorlevel 1 (
  echo [X] %SVC% did not stop, so it was not removed. Do not use taskkill /f.
  goto :end
)
"%NSSM%" remove "%SVC%" confirm
echo Removed. All folders and data are still there.

:end
echo.
pause
endlocal
exit /b

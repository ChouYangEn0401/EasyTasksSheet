@echo off
@echo off
rem ============================================================================
rem  EasyTasksSheet：停止並移除 Windows 服務 easytasks
rem  不刪資料夾與資料，不強制結束行程。要重新註冊用 install_easytasks_service.bat
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "SVC=easytasks"
set "NSSM=C:\nssm\win64\nssm.exe"

sc query "%SVC%" >nul 2>&1
if errorlevel 1 (
  echo 服務 %SVC% 不存在，沒有要做的事。
  goto :end
)
for %%K in (Application AppDirectory AppParameters) do (
  for /f "delims=" %%V in ('"%NSSM%" get %SVC% %%K 2^>nul') do echo   %%K = %%V
)
set "ANS="
set /p "ANS=確定要停止並移除 %SVC% 請輸入 YES： "
if not "!ANS!"=="YES" (
  echo 已取消。
  goto :end
)
net stop "%SVC%"
sc query "%SVC%" | findstr /C:"STOPPED" >nul
if errorlevel 1 (
  echo [X] %SVC% 停不下來，沒有移除。不要用 taskkill /f。
  goto :end
)
"%NSSM%" remove "%SVC%" confirm
echo 已移除。資料夾與資料都還在。

:end
echo.
pause
endlocal

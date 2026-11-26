@echo off
@echo off
rem ============================================================================
rem  EasyTasksSheet：用 NSSM 註冊（或重建）Windows 服務 easytasks
rem  用法（系統管理員 cmd）：
rem    install_easytasks_service.bat check   只檢查，不改任何東西
rem    install_easytasks_service.bat         檢查 -> 輸入 YES -> 停止並移除舊服務 -> 重建 -> 啟動 -> 驗證
rem  不會：建立 .venv、安裝套件、建置前端、複製 .env、刪除任何資料夾（那些是 setup_easytasks.bat 的事）
rem  存檔：UTF-8，換行 CRLF
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

rem 專案路徑：本腳本在 <專案>\deploy\windows\，往上兩層就是專案根目錄（clone 到哪裡都適用）
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
rem ---- 設定區（只需要改這裡）----
set "SVC=easytasks"
set "PORT=8100"
set "NSSM=C:\nssm\win64\nssm.exe"
rem --------------------------------
set "PY=%APP_DIR%\.venv\Scripts\python.exe"
set "LOGDIR=%APP_DIR%\logs"
set "MODE=%~1"

echo.
echo === [1/4] 事前檢查 ===
set "ERR=0"
if not exist "%NSSM%" ( echo   [X] 找不到 NSSM：%NSSM% & set "ERR=1" )
if not exist "%APP_DIR%\main.py" ( echo   [X] 找不到 %APP_DIR%\main.py：資料夾路徑不對，或還沒 clone & set "ERR=1" )
if not exist "%PY%" ( echo   [X] 找不到 %PY%：先執行 setup_easytasks.bat 建立 .venv & set "ERR=1" )
if not exist "%APP_DIR%\.env" ( echo   [X] 找不到 %APP_DIR%\.env：先執行 setup_easytasks.bat & set "ERR=1" )
if not exist "%APP_DIR%\dist\web\index.html" ( echo   [X] 找不到前端建置檔 dist\web\index.html：先執行 setup_easytasks.bat & set "ERR=1" )
if exist "%APP_DIR%\.env" (
  call :checkenv "HOST=127.0.0.1"
  call :checkenv "PORT=%PORT%"
  call :checkenv "BASE_PATH=/easytasks"
  call :checkenv "NODE_ENV=production"
  call :checkenv "TRUSTED_PROXY=true"
)
sc query "%SVC%" >nul 2>&1
if errorlevel 1 (
  echo   服務 %SVC% 目前不存在，將新建。
  netstat -ano | findstr /R /C:"127.0.0.1:%PORT% .*LISTENING" /C:"0.0.0.0:%PORT% .*LISTENING" >nul
  if not errorlevel 1 ( echo   [X] port %PORT% 已被其他程式占用：netstat -ano ^| findstr :%PORT% 查是誰 & set "ERR=1" )
) else (
  echo   服務 %SVC% 已存在，目前設定：
  for %%K in (Application AppDirectory AppParameters) do (
    for /f "delims=" %%V in ('"%NSSM%" get %SVC% %%K 2^>nul') do echo     %%K = %%V
  )
)
if "%ERR%"=="1" (
  echo.
  echo 有錯誤，沒有改任何東西。
  goto :end
)
echo   全部通過。

if /i "%MODE%"=="check" (
  echo.
  echo check 模式：只檢查，沒有改任何東西。
  goto :end
)

echo.
echo 接下來會停止並移除舊的 %SVC% 服務（若存在），再用上面的設定重建並啟動。
echo 資料（%APP_DIR%\data）不會被動到。
set "ANS="
set /p "ANS=確定要繼續請輸入 YES： "
if not "!ANS!"=="YES" (
  echo 已取消，沒有改任何東西。
  goto :end
)

echo.
echo === [2/4] 停止並移除舊服務 ===
sc query "%SVC%" >nul 2>&1
if errorlevel 1 (
  echo   沒有舊服務，略過。
) else (
  net stop "%SVC%" >nul 2>&1
  sc query "%SVC%" | findstr /C:"STOPPED" >nul
  if errorlevel 1 (
    echo   [X] %SVC% 停不下來。不要用 taskkill /f，先看 %LOGDIR%\easytasks.err.log。
    goto :end
  )
  "%NSSM%" remove "%SVC%" confirm
)

echo.
echo === [3/4] 建立服務 ===
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
"%NSSM%" install "%SVC%" "%PY%"
"%NSSM%" set "%SVC%" AppParameters "main.py"
"%NSSM%" set "%SVC%" AppDirectory "%APP_DIR%"
"%NSSM%" set "%SVC%" DisplayName "EasyTasksSheet Web Service"
"%NSSM%" set "%SVC%" Description "EasyTasksSheet (FastAPI) behind nginx /easytasks/, 127.0.0.1:%PORT%"
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
echo === [4/4] 驗證 ===
timeout /t 5 /nobreak >nul
sc query "%SVC%" | findstr /C:"RUNNING" >nul
if errorlevel 1 ( echo   [X] 服務不是 RUNNING ) else ( echo   [OK] 服務 RUNNING )
netstat -ano | findstr /R /C:"0.0.0.0:%PORT% .*LISTENING" >nul
if not errorlevel 1 echo   [X] port %PORT% 綁在 0.0.0.0：.env 的 HOST 應為 127.0.0.1
netstat -ano | findstr /R /C:"127.0.0.1:%PORT% .*LISTENING" >nul
if errorlevel 1 ( echo   [X] 127.0.0.1:%PORT% 沒有在聽 ) else ( echo   [OK] 127.0.0.1:%PORT% 在聽 )
for /f %%S in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:%PORT%/api/health).StatusCode } catch { 0 }"') do set "CODE=%%S"
if "!CODE!"=="200" ( echo   [OK] /api/health 回 200 ) else ( echo   [X] /api/health 回 !CODE! )
echo   --- 啟動 log 最後 15 行 ---
powershell -NoProfile -Command "if (Test-Path '%LOGDIR%\easytasks.out.log') { Get-Content '%LOGDIR%\easytasks.out.log' -Tail 15 -Encoding UTF8 }"
powershell -NoProfile -Command "if (Test-Path '%LOGDIR%\easytasks.err.log') { Get-Content '%LOGDIR%\easytasks.err.log' -Tail 15 -Encoding UTF8 }"
echo.
echo 下一步：nginx 加上 location /easytasks/（deploy\windows\nginx-easytasks.conf），nginx -t 後 reload，
echo 再從校內電腦開 https://140.112.180.152/easytasks/
goto :end

:checkenv
findstr /B /C:"%~1" "%APP_DIR%\.env" >nul
if errorlevel 1 (
  echo   [X] .env 裡沒有 %~1
  set "ERR=1"
)
exit /b 0

:end
echo.
pause
endlocal

@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ==========================================
echo  服務安裝腳本
echo  EasyTasksSheet
echo ==========================================
echo.

:: ========== 【環境設定】==========
set NSSM="C:\nssm\win64\nssm.exe"

:: EasyTasksSheet 設定
set TASKS_DIR=C:\EasyTasksSheet
set TASKS_PYTHON=C:\EasyTasksSheet\.venv\Scripts\python.exe
set TASKS_ENTRY=main.py
:: ==============================================

echo 檢查必要檔案...

if not exist %NSSM% (
    echo [錯誤] 找不到 NSSM: %NSSM%
    pause
    exit /b 1
)

if not exist "%TASKS_PYTHON%" (
    echo [錯誤] 找不到 Python: %TASKS_PYTHON%
    echo        請先執行 C:\scripts\easytasks_setup.bat
    pause
    exit /b 1
)

if not exist "%TASKS_DIR%\.env" (
    echo [錯誤] 找不到 %TASKS_DIR%\.env，請先執行 C:\scripts\easytasks_setup.bat
    pause
    exit /b 1
)

if not exist "%TASKS_DIR%\dist\web\index.html" (
    echo [錯誤] 找不到前端建置檔，請先執行 C:\scripts\easytasks_setup.bat
    pause
    exit /b 1
)

echo [1/1] 處理 EasyTasksSheet 服務...

sc query easytasks >nul 2>&1

if %errorlevel% == 0 (
    echo    停止舊的 EasyTasksSheet 服務...
    net stop easytasks >nul 2>&1

    echo    刪除舊的 EasyTasksSheet 服務...
    %NSSM% remove easytasks confirm >nul 2>&1

    timeout /t 1 >nul
)

echo    安裝 EasyTasksSheet 服務...

if not exist "%TASKS_DIR%\logs" mkdir "%TASKS_DIR%\logs"

%NSSM% install easytasks "%TASKS_PYTHON%"
%NSSM% set easytasks AppDirectory "%TASKS_DIR%"
%NSSM% set easytasks AppParameters "%TASKS_ENTRY%"
%NSSM% set easytasks DisplayName "EasyTasksSheet Web Service"
%NSSM% set easytasks Description "EasyTasksSheet (FastAPI) behind nginx /easytasks/, 127.0.0.1:8100"
%NSSM% set easytasks Start SERVICE_AUTO_START

:: 日誌：UTF-8 + 不緩衝
%NSSM% set easytasks AppEnvironmentExtra PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
%NSSM% set easytasks AppStdout "%TASKS_DIR%\logs\easytasks.out.log"
%NSSM% set easytasks AppStderr "%TASKS_DIR%\logs\easytasks.err.log"
%NSSM% set easytasks AppRotateFiles 1
%NSSM% set easytasks AppRotateBytes 10485760

:: 程式結束就 5 秒後自動重啟
%NSSM% set easytasks AppExit Default Restart
%NSSM% set easytasks AppRestartDelay 5000

echo    啟動 EasyTasksSheet 服務...

net start easytasks

if %errorlevel% neq 0 (
    echo [錯誤] EasyTasksSheet 啟動失敗，請看 %TASKS_DIR%\logs\easytasks.err.log
) else (
    echo    EasyTasksSheet 完成
)

echo.

:: ========== 完成檢查 ==========
echo ==========================================
echo  安裝完成！
echo ==========================================
echo.

echo 請確認以下狀態：

PowerShell -Command "Get-Service easytasks | Format-Table -AutoSize"

echo.

echo 請確認端口綁定（應該是 127.0.0.1:8100，不能是 0.0.0.0）：

PowerShell -Command "Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 8100} | Select-Object LocalAddress, LocalPort | Format-Table -AutoSize"

echo.

echo 健康檢查（應該是 200）：

PowerShell -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8100/api/health).StatusCode } catch { $_.Exception.Message }"

echo.

pause

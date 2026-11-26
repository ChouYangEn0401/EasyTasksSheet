@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ==========================================
echo  服務安裝腳本
echo  Gitea + Nginx + Python-DMS + EasyTasksSheet
echo ==========================================
echo.

:: ========== 【環境設定】==========
set GITEA_ROOT=C:\gitea
set NGINX_ROOT=C:\nginx
set NSSM="C:\nssm\win64\nssm.exe"

:: Python-DMS 設定
set DMS_DIR=C:\pyDMS

set PYTHON_EXE=C:\pyDMS\.venv\Scripts\python.exe
set DMS_ENTRY=run.py

:: EasyTasksSheet 設定（環境先用 easytasks_setup.bat 準備好）
set TASKS_DIR=C:\EasyTasksSheet
set TASKS_PYTHON=C:\EasyTasksSheet\.venv\Scripts\python.exe
set TASKS_ENTRY=main.py
:: ==============================================

echo 檢查必要檔案...

if not exist "%GITEA_ROOT%\gitea.exe" (
    echo [錯誤] 找不到 %GITEA_ROOT%\gitea.exe
    pause
    exit /b 1
)

if not exist "%NGINX_ROOT%\nginx.exe" (
    echo [錯誤] 找不到 %NGINX_ROOT%\nginx.exe
    pause
    exit /b 1
)

if not exist "%NSSM%" (
    echo [錯誤] 找不到 NSSM: %NSSM%
    pause
    exit /b 1
)

if not exist "%PYTHON_EXE%" (
    echo [錯誤] 找不到 Python: %PYTHON_EXE%
    pause
    exit /b 1
)

if not exist "%TASKS_PYTHON%" (
    echo [錯誤] 找不到 EasyTasksSheet 的 Python: %TASKS_PYTHON%
    echo        請先執行 C:\scripts\easytasks_setup.bat
    pause
    exit /b 1
)

:: ========== 0. 清理手動啟動的殘留進程 ==========
echo [0] 清理手動啟動的殘留進程...

taskkill /f /im nginx.exe >nul 2>&1
taskkill /f /im gitea.exe >nul 2>&1

timeout /t 2 >nul
echo.

:: ========== 1. Gitea ==========
echo [1/4] 處理 Gitea 服務...

sc query gitea >nul 2>&1

if %errorlevel% == 0 (
    echo    停止舊的 Gitea 服務...
    net stop gitea >nul 2>&1

    echo    刪除舊的 Gitea 服務...
    sc delete gitea >nul 2>&1

    timeout /t 2 >nul
)

cd /d "%GITEA_ROOT%"

echo    安裝 Gitea 服務（官方內建模式）...

gitea.exe manager service install

if %errorlevel% neq 0 (
    echo [警告] Gitea 內建模式失敗，改用 sc.exe 備援...

    sc create gitea ^
        binPath= "\"%GITEA_ROOT%\gitea.exe\" web --config \"%GITEA_ROOT%\custom\conf\app.ini\"" ^
        start= auto ^
        DisplayName= "Gitea Git Server"
) else (
    sc config gitea start= auto >nul
)

echo    啟動 Gitea 服務...

net start gitea

if %errorlevel% neq 0 (
    echo [錯誤] Gitea 啟動失敗
) else (
    echo    Gitea 完成
)

echo.

:: ========== 2. Nginx ==========
echo [2/4] 處理 Nginx 服務...

sc query nginx >nul 2>&1

if %errorlevel% == 0 (
    echo    停止舊的 Nginx 服務...
    net stop nginx >nul 2>&1

    echo    刪除舊的 Nginx 服務...
    "%NSSM%" remove nginx confirm >nul 2>&1

    timeout /t 1 >nul
)

echo    安裝 Nginx 服務...

"%NSSM%" install nginx "%NGINX_ROOT%\nginx.exe"
"%NSSM%" set nginx AppDirectory "%NGINX_ROOT%"
"%NSSM%" set nginx DisplayName "Nginx Reverse Proxy"
"%NSSM%" set nginx Description "Nginx for Gitea and Python-DMS"
"%NSSM%" set nginx Start SERVICE_AUTO_START

echo    啟動 Nginx 服務...

net start nginx

if %errorlevel% neq 0 (
    echo [錯誤] Nginx 啟動失敗
) else (
    echo    Nginx 完成
)

echo.

:: ========== 3. Python-DMS ==========
echo [3/4] 處理 Python-DMS 服務...

:: 如果舊的 python-dms 服務存在，先刪除
sc query python-dms >nul 2>&1

if %errorlevel% == 0 (
    echo    停止舊的 Python-DMS 服務...
    net stop python-dms >nul 2>&1

    echo    刪除舊的 Python-DMS 服務...
    "%NSSM%" remove python-dms confirm >nul 2>&1

    timeout /t 1 >nul
)

echo    安裝 Python-DMS 服務...

:: 日誌資料夾（gitignored，乾淨 clone 不會有，NSSM 不會自己建）
if not exist "%DMS_DIR%\logs" mkdir "%DMS_DIR%\logs"

"%NSSM%" install python-dms "%PYTHON_EXE%"
"%NSSM%" set python-dms AppDirectory "%DMS_DIR%"
"%NSSM%" set python-dms AppParameters "%DMS_ENTRY%"
"%NSSM%" set python-dms DisplayName "Python-DMS Web Service"
"%NSSM%" set python-dms Description "Python DMS FastAPI Application"
"%NSSM%" set python-dms Start SERVICE_AUTO_START

:: 日誌：UTF-8 + 不緩衝，否則中文/emoji 會炸、訊息會卡在緩衝區
"%NSSM%" set python-dms AppEnvironmentExtra PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
"%NSSM%" set python-dms AppStdout "%DMS_DIR%\logs\dms.out.log"
"%NSSM%" set python-dms AppStderr "%DMS_DIR%\logs\dms.err.log"
"%NSSM%" set python-dms AppRotateFiles 1
"%NSSM%" set python-dms AppRotateBytes 10485760

echo    啟動 Python-DMS 服務...

net start python-dms

if %errorlevel% neq 0 (
    echo [錯誤] Python-DMS 啟動失敗
) else (
    echo    Python-DMS 完成
)

echo.

:: ========== 4. EasyTasksSheet ==========
echo [4/4] 處理 EasyTasksSheet 服務...

sc query easytasks >nul 2>&1

if %errorlevel% == 0 (
    echo    停止舊的 EasyTasksSheet 服務...
    net stop easytasks >nul 2>&1

    echo    刪除舊的 EasyTasksSheet 服務...
    "%NSSM%" remove easytasks confirm >nul 2>&1

    timeout /t 1 >nul
)

echo    安裝 EasyTasksSheet 服務...

if not exist "%TASKS_DIR%\logs" mkdir "%TASKS_DIR%\logs"

"%NSSM%" install easytasks "%TASKS_PYTHON%"
"%NSSM%" set easytasks AppDirectory "%TASKS_DIR%"
"%NSSM%" set easytasks AppParameters "%TASKS_ENTRY%"
"%NSSM%" set easytasks DisplayName "EasyTasksSheet Web Service"
"%NSSM%" set easytasks Description "EasyTasksSheet (FastAPI) behind nginx /easytasks/, 127.0.0.1:8100"
"%NSSM%" set easytasks Start SERVICE_AUTO_START
"%NSSM%" set easytasks AppEnvironmentExtra PYTHONIOENCODING=utf-8 PYTHONUNBUFFERED=1
"%NSSM%" set easytasks AppStdout "%TASKS_DIR%\logs\easytasks.out.log"
"%NSSM%" set easytasks AppStderr "%TASKS_DIR%\logs\easytasks.err.log"
"%NSSM%" set easytasks AppRotateFiles 1
"%NSSM%" set easytasks AppRotateBytes 10485760
"%NSSM%" set easytasks AppExit Default Restart
"%NSSM%" set easytasks AppRestartDelay 5000

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
echo  所有服務安裝完成！
echo ==========================================
echo.

echo 請確認以下狀態：

PowerShell -Command "Get-Service gitea, nginx, python-dms, easytasks | Format-Table -AutoSize"

echo.

echo 請確認端口綁定：

PowerShell -Command "Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in 80,443,3000,8000,8100} | Select-Object LocalAddress, LocalPort | Sort-Object LocalPort | Format-Table -AutoSize"

echo.

pause
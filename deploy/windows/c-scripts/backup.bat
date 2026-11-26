@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ==========================================
echo  備份腳本 - Gitea + Nginx + FastAPI + EasyTasksSheet
echo ==========================================
echo.

:: ========== 【已根據你的環境設定】==========
set GITEA_ROOT=C:\gitea
set NGINX_ROOT=C:\nginx
set FASTAPI_ROOT=C:\pyDMS
set SCRIPTS_ROOT=C:\scripts
set TASKS_ROOT=C:\EasyTasksSheet

:: NAS 備份路徑（請改成你的 NAS 實際路徑！）
:: 範例：\\192.168.1.100\backup\server
set NAS_PATH=\\YOUR_NAS_IP\backup\gitea-server

:: 本地備份暫存區
set BACKUP_ROOT=C:\backup-temp
:: ==============================================

:: 產生時間戳：YYYYMMDD_HHMM
set TIMESTAMP=%date:~0,4%%date:~5,2%%date:~8,2%_%time:~0,2%%time:~3,2%
set TIMESTAMP=%TIMESTAMP: =0%
set BACKUP_DIR=%BACKUP_ROOT%\%TIMESTAMP%

echo 備份時間: %TIMESTAMP%
echo.

:: ========== 1. 停止 Gitea（確保資料庫一致）==========
echo [1/5] 停止 Gitea 服務...
net stop gitea
echo.

:: ========== 2. 本地備份 ==========
echo [2/5] 複製檔案到本地備份區...
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo   備份 Gitea...
xcopy /E /I /Y "%GITEA_ROOT%" "%BACKUP_DIR%\gitea\"

echo   備份 Nginx...
xcopy /E /I /Y "%NGINX_ROOT%" "%BACKUP_DIR%\nginx\"

echo   備份 FastAPI...
xcopy /E /I /Y "%FASTAPI_ROOT%" "%BACKUP_DIR%\fastapi\"

echo   備份 EasyTasksSheet（資料庫用線上備份，不用停服務；另帶 .env）...
if exist "%TASKS_ROOT%\.venv\Scripts\python.exe" (
    pushd "%TASKS_ROOT%"
    "%TASKS_ROOT%\.venv\Scripts\python.exe" -m server.cli backup --out "%BACKUP_DIR%\easytasks" --keep 1
    popd
    if exist "%TASKS_ROOT%\.env" copy /Y "%TASKS_ROOT%\.env" "%BACKUP_DIR%\easytasks\env" >nul
) else (
    echo   [警告] 找不到 EasyTasksSheet，略過
)

echo   備份腳本...
xcopy /E /I /Y "%SCRIPTS_ROOT%" "%BACKUP_DIR%\scripts\"
echo.

:: ========== 3. 複製到 NAS ==========
echo [3/5] 複製到 NAS...
if not exist "%NAS_PATH%" (
    echo [警告] 無法連線到 NAS: %NAS_PATH%
    echo 請確認：
    echo   1. NAS 路徑正確
    echo   2. 這台伺服器有權限存取 NAS
    echo   3. 如果 NAS 需要帳號密碼，請先執行：
    echo      net use %NAS_PATH% /user:帳號 密碼
    echo.
    echo [本次僅保留本地備份]
) else (
    xcopy /E /I /Y "%BACKUP_DIR%" "%NAS_PATH%\%TIMESTAMP%\"
    echo NAS 備份完成: %NAS_PATH%\%TIMESTAMP%\
)
echo.

:: ========== 4. 清理舊備份（保留最近 10 份）==========
echo [4/5] 清理舊備份（保留 10 份）...
for /f "skip=10 delims=" %%a in ('dir /b /ad /o-d "%BACKUP_ROOT%"') do (
    echo   刪除舊備份: %BACKUP_ROOT%\%%a
    rd /s /q "%BACKUP_ROOT%\%%a"
)
echo.

:: ========== 5. 重新啟動服務 ==========
echo [5/5] 重新啟動所有服務...
net start gitea
net start nginx
net start python-dms
echo.

echo ==========================================
echo  備份完成！
echo  本地: %BACKUP_DIR%
if exist "%NAS_PATH%\%TIMESTAMP%\" (
    echo  NAS:  %NAS_PATH%\%TIMESTAMP%\
) else (
    echo  NAS:  [未連線]
)
echo ==========================================
pause

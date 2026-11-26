@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo ==========================================
echo  環境安裝腳本
echo  EasyTasksSheet
echo ==========================================
echo.

:: ========== 【環境設定】==========
set TASKS_DIR=C:\EasyTasksSheet
set REPO_URL=https://github.com/ChouYangEn0401/EasyTasksSheet.git
:: ==============================================

:: ========== 1. 程式碼 ==========
echo [1/5] 取得程式碼...
if exist "%TASKS_DIR%\main.py" (
    echo    已存在，執行 git pull...
    pushd "%TASKS_DIR%"
    git pull --ff-only
    popd
) else (
    git clone "%REPO_URL%" "%TASKS_DIR%"
    if !errorlevel! neq 0 (
        echo [錯誤] git clone 失敗
        pause
        exit /b 1
    )
)
cd /d "%TASKS_DIR%"
echo.

:: ========== 2. Python 虛擬環境 ==========
echo [2/5] 建立 .venv 並安裝套件...
if not exist ".venv\Scripts\python.exe" (
    py -3.11 -m venv .venv 2>nul || py -3 -m venv .venv
    if not exist ".venv\Scripts\python.exe" (
        echo [錯誤] 建立 venv 失敗，請確認已安裝 Python 3.11 以上（所有使用者）
        pause
        exit /b 1
    )
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [錯誤] pip 安裝失敗
    pause
    exit /b 1
)
echo.

:: ========== 3. .env ==========
echo [3/5] 設定檔 .env...
if exist ".env" (
    echo    .env 已存在，不覆蓋
) else (
    copy /Y "deploy\windows\env.152.example" ".env" >nul
    echo    已建立 .env（範本：deploy\windows\env.152.example）
)
echo.

:: ========== 4. 建置前端 ==========
echo [4/5] 建置前端（需要 Node.js 22）...
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [錯誤] 找不到 npm，請先安裝 Node.js 22 LTS 後重開 cmd
    pause
    exit /b 1
)
call npm ci
if %errorlevel% neq 0 (
    echo [錯誤] npm ci 失敗
    pause
    exit /b 1
)
call npm run build
if %errorlevel% neq 0 (
    echo [錯誤] npm run build 失敗
    pause
    exit /b 1
)
echo.

:: ========== 5. 資料夾 ==========
echo [5/5] 建立資料夾...
if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"
if not exist "backups" mkdir "backups"
echo.

echo ==========================================
echo  環境安裝完成！
echo  下一步：C:\scripts\easytasks_installer.bat（建立 NSSM 服務）
echo ==========================================
pause

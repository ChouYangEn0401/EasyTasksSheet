@echo off
@echo off
rem ============================================================================
rem  EasyTasksSheet：第一次準備（或重建）程式環境。不註冊服務、不停任何服務。
rem  做的事：建 .venv -> 安裝 Python 套件 -> 放 .env（已存在就不動）-> 建置前端 -> 建 data、logs
rem  前提：已經 git clone 專案（本腳本自動以所在專案為準）；已安裝 Python 3.11 以上（所有使用者）。Node.js 不用先裝：沒有時自動下載免安裝版到 .tools\node
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
rem 專案路徑：本腳本在 <專案>\deploy\windows\，往上兩層就是專案根目錄（clone 到哪裡都適用）
set "SCRIPT_DIR=%~dp0"
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"

if not exist "%APP_DIR%\main.py" (
  echo [X] 找不到 %APP_DIR%\main.py：本腳本要放在專案的 deploy\windows\ 裡執行。
  goto :end
)
cd /d "%APP_DIR%"

echo === [1/4] Python 環境 ===
if not exist ".venv\Scripts\python.exe" (
  py -3.11 -m venv .venv 2>nul || py -3 -m venv .venv
  if not exist ".venv\Scripts\python.exe" ( echo [X] 建立 venv 失敗：確認已安裝 Python 3.11 以上與 py launcher & goto :end )
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt || ( echo [X] pip 安裝失敗 & goto :end )
".venv\Scripts\python.exe" --version

echo === [2/4] .env ===
if exist ".env" (
  echo   .env 已存在，不覆蓋。
) else (
  copy /Y "deploy\windows\env.152.example" ".env" >nul
  echo   已從 deploy\windows\env.152.example 建立 .env，請用記事本確認 BACKUP_DIR 等值。
)

echo === [3/4] 建置前端（會讀 .env 的 BASE_PATH）===
call :ensure_node || goto :end
call npm ci || ( echo [X] npm ci 失敗 & goto :end )
call npm run build || ( echo [X] npm run build 失敗 & goto :end )

echo === [4/4] 資料夾 ===
if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"
if not exist "backups" mkdir "backups"
echo 完成。下一步：install_easytasks_service.bat check

:end
echo.
pause
endlocal

exit /b

rem ---- 確保有 npm：系統有就用系統的；沒有就用（或下載）專案內的免安裝版 Node.js 22 ----
rem 放在括號區塊外，避免 PATH 裡的 "Program Files (x86)" 弄壞 if ( ... ) 的解析
:ensure_node
set "NODE_DIR=%APP_DIR%\.tools\node"
rem 系統的 Node 要 v22 以上才用（package.json 要求 >=22.18）；太舊就改用專案內的免安裝版
set "SYS_NODE_MAJOR="
for /f "tokens=1 delims=." %%V in ('node -v 2^>nul') do set "SYS_NODE_MAJOR=%%V"
rem 沒裝 Node 時變數未定義，不能對它做 :v= 取代（會得到怪值），所以先判斷 defined、用延遲展開
if defined SYS_NODE_MAJOR set "SYS_NODE_MAJOR=!SYS_NODE_MAJOR:v=!"
if defined SYS_NODE_MAJOR if !SYS_NODE_MAJOR! GEQ 22 (
  where npm >nul 2>&1
  if not errorlevel 1 exit /b 0
)
if defined SYS_NODE_MAJOR echo   系統的 Node 版本太舊（v!SYS_NODE_MAJOR!），改用專案內的免安裝版 Node.js 22
if exist "%NODE_DIR%\npm.cmd" goto :ensure_node_path
echo   找不到 npm：自動下載免安裝版 Node.js 22 到 %NODE_DIR%
echo   （只給本專案建置前端用，不跑安裝程式、不改系統設定）
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%ensure-node.ps1" -ProjectDir "%APP_DIR%"
if errorlevel 1 (
  echo [X] 下載 Node.js 失敗：確認這台電腦連得到 nodejs.org；
  echo     或手動安裝 Node.js 22 LTS 後重開 cmd 再執行
  exit /b 1
)
:ensure_node_path
set "PATH=%NODE_DIR%;%PATH%"
exit /b 0

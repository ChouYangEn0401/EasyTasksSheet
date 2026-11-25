@echo off
@echo off
rem ============================================================================
rem  EasyTasksSheet：更新到最新程式碼並重啟服務
rem  順序：先備份資料庫 -> git pull --ff-only -> 安裝套件 -> 建置前端 -> 重啟服務 -> 健康檢查
rem  任何一步失敗就停下來，服務維持原狀（建置失敗時不會重啟）
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "APP_DIR=C:\EasyTasksSheet"
set "SVC=easytasks"
set "PORT=8100"
set "PY=%APP_DIR%\.venv\Scripts\python.exe"
cd /d "%APP_DIR%" || goto :end

echo === [1/5] 更新前先備份 ===
"%PY%" -m server.cli backup || ( echo [X] 備份失敗，停止更新 & goto :end )

echo === [2/5] git pull ===
git status --porcelain --untracked-files=no | findstr . >nul
if not errorlevel 1 (
  echo [X] 工作副本有未提交的修改，先處理再更新：git status
  goto :end
)
git pull --ff-only || ( echo [X] git pull 失敗 & goto :end )
git log -1 --format="  目前版本：%%h %%ci %%s"

echo === [3/5] Python 套件 ===
"%PY%" -m pip install -r requirements.txt || ( echo [X] pip 安裝失敗 & goto :end )

echo === [4/5] 建置前端 ===
call npm ci || ( echo [X] npm ci 失敗 & goto :end )
call npm run build || ( echo [X] npm run build 失敗，服務沒有重啟 & goto :end )

echo === [5/5] 重啟服務 ===
net stop "%SVC%"
net start "%SVC%"
timeout /t 5 /nobreak >nul
for /f %%S in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:%PORT%/api/health).StatusCode } catch { 0 }"') do set "CODE=%%S"
if "!CODE!"=="200" ( echo [OK] 更新完成，/api/health 回 200 ) else ( echo [X] /api/health 回 !CODE!，看 logs\easytasks.err.log )

:end
echo.
pause
endlocal

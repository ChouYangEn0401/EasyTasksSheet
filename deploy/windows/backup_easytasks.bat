@echo off
@echo off
rem ============================================================================
rem  EasyTasksSheet：備份資料庫與附件（給「工作排程器」每天執行，也可以手動執行）
rem  備份位置與保留份數看 .env 的 BACKUP_DIR、BACKUP_KEEP。結果附加到 logs\backup.log
rem  不需要停服務（SQLite 線上備份）。沒有 pause，排程才不會卡住。
rem  註冊排程（系統管理員 cmd，每天 03:17，用 SYSTEM 帳號）：
rem    schtasks /Create /TN "EasyTasksSheet Backup" /TR "<專案路徑>\deploy\windows\backup_easytasks.bat" /SC DAILY /ST 03:17 /RU SYSTEM /F
rem  立刻跑一次：schtasks /Run /TN "EasyTasksSheet Backup"
rem ============================================================================
setlocal EnableExtensions
chcp 65001 >nul
rem 專案路徑：本腳本在 <專案>\deploy\windows\，往上兩層就是專案根目錄（clone 到哪裡都適用）
for %%I in ("%~dp0..\..") do set "APP_DIR=%%~fI"
cd /d "%APP_DIR%" || exit /b 1
if not exist "logs" mkdir "logs"
set "PYTHONIOENCODING=utf-8"
echo ==== %DATE% %TIME% ==== >> "logs\backup.log"
"%APP_DIR%\.venv\Scripts\python.exe" -m server.cli backup >> "logs\backup.log" 2>&1
set "RC=%ERRORLEVEL%"
echo exit code %RC% >> "logs\backup.log"
endlocal & exit /b %RC%

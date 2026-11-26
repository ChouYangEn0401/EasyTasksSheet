@echo off
chcp 65001 >nul
echo ==========================================
echo   正在重新啟動 Gitea, Nginx, Python-DMS, EasyTasksSheet 服務...
echo ==========================================
echo.

echo [1/4] 重新啟動 Gitea...
net stop gitea >nul 2>&1
net start gitea

echo [2/4] 重新啟動 Nginx...
net stop nginx >nul 2>&1
net start nginx

echo [3/4] 重新啟動 Python-DMS...
net stop python-dms
net start python-dms

echo [4/4] 重新啟動 EasyTasksSheet...
net stop easytasks
net start easytasks

echo.
echo ==========================================
echo   所有服務重啟指令已發送！
echo ==========================================
pause


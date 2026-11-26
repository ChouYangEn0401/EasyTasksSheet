@echo off
chcp 65001 >nul
echo ==========================================
echo   正在關閉 Gitea, Nginx, Python-DMS, EasyTasksSheet 服務...
echo ==========================================
echo.

echo [1/4] 執行關閉 Gitea...
net stop gitea >nul 2>&1

echo [2/4] 執行關閉 Nginx...
net stop nginx >nul 2>&1

echo [3/4] 執行關閉 Python-DMS...
net stop python-dms

echo [4/4] 執行關閉 EasyTasksSheet...
net stop easytasks

echo.
echo ==========================================
echo   所有服務關閉指令已發送！
echo ==========================================
pause


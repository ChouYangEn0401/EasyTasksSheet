@echo off
@echo off
rem ============================================================================
rem  套用 EasyTasksSheet 的 nginx 設定與首頁導覽頁（系統管理員 cmd）
rem  用法：
rem    apply_nginx.bat check   只比對「152 現在的檔案」與「新檔案」的差異，不改任何東西
rem    apply_nginx.bat         備份 -> 換上新檔 -> nginx -t -> 通過才 reload；失敗自動還原
rem  換的檔案：C:\nginx\conf\nginx.conf、C:\nginx\html\jump_page.html
rem  不會：重啟 nginx 服務、動 Gitea / pyDMS / 防火牆
rem ============================================================================
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "NGINX_DIR=C:\nginx"
set "SRC=%~dp0"
set "CONF=%NGINX_DIR%\conf\nginx.conf"
set "JUMP=%NGINX_DIR%\html\jump_page.html"
set "MODE=%~1"

if not exist "%NGINX_DIR%\nginx.exe" ( echo [X] 找不到 %NGINX_DIR%\nginx.exe & goto :end )
if not exist "%SRC%nginx.conf" ( echo [X] 找不到 %SRC%nginx.conf & goto :end )
if not exist "%SRC%jump_page.html" ( echo [X] 找不到 %SRC%jump_page.html & goto :end )

echo === 比對 nginx.conf：只看設定行，忽略註解與空白 ===
powershell -NoProfile -Command "$f={param($p) Get-Content $p -Encoding UTF8 | ForEach-Object { ($_ -replace '#.*$','').Trim() } | Where-Object { $_ }}; $d=Compare-Object (& $f '%CONF%') (& $f '%SRC%nginx.conf'); if ($d) { $d | ForEach-Object { if ($_.SideIndicator -eq '=>') { '  + 新增  ' + $_.InputObject } else { '  - 移除  ' + $_.InputObject } } } else { '  （設定行完全相同）' }"
echo.
echo 預期只有「+ 新增」的 EasyTasksSheet 那幾行（location /easytasks 等），沒有任何「- 移除」。
echo 如果看到「- 移除」，代表 152 上的 nginx.conf 和交接書記錄的不一樣：先停下來，把畫面給負責人看。

if /i "%MODE%"=="check" (
  echo.
  echo check 模式：沒有改任何東西。
  goto :end
)

echo.
set "ANS="
set /p "ANS=確定要套用請輸入 YES： "
if not "!ANS!"=="YES" ( echo 已取消，沒有改任何東西。 & goto :end )

for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%T"
copy /Y "%CONF%" "%CONF%.bak_%TS%" >nul || ( echo [X] 備份 nginx.conf 失敗 & goto :end )
if exist "%JUMP%" copy /Y "%JUMP%" "%JUMP%.bak_%TS%" >nul
echo [OK] 已備份：nginx.conf.bak_%TS%、jump_page.html.bak_%TS%

copy /Y "%SRC%nginx.conf" "%CONF%" >nul
copy /Y "%SRC%jump_page.html" "%JUMP%" >nul

cd /d "%NGINX_DIR%"
nginx.exe -t
if errorlevel 1 (
  echo [X] nginx -t 沒通過，還原舊檔，nginx 維持原狀。
  copy /Y "%CONF%.bak_%TS%" "%CONF%" >nul
  if exist "%JUMP%.bak_%TS%" copy /Y "%JUMP%.bak_%TS%" "%JUMP%" >nul
  goto :end
)
nginx.exe -s reload
if errorlevel 1 (
  echo [X] reload 失敗。設定檔已通過檢查；可改用 net stop nginx 再 net start nginx。
  goto :end
)
echo [OK] nginx 已 reload。

echo.
echo === 驗證（本機）===
for /f %%S in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8100/api/health).StatusCode } catch { 0 }"') do set "CODE=%%S"
if "!CODE!"=="200" ( echo   [OK] 後端 127.0.0.1:8100 回 200 ) else ( echo   [!] 後端 8100 回 !CODE!：easytasks 服務還沒裝好或沒在跑，網頁會是 502 )
echo   nginx 在 443 擋掉 127.0.0.1（不在白名單），所以經 nginx 的測試請用校內電腦：
echo     https://140.112.180.152/            首頁要看到四張卡片
echo     https://140.112.180.152/easytasks/  EasyTasksSheet 登入頁
echo     https://140.112.180.152/pydms/  與  /gitea/  照常可用
echo.
echo 要退回：copy /Y "%CONF%.bak_%TS%" "%CONF%" 與 jump_page.html 的 .bak，再 nginx.exe -t、nginx.exe -s reload

:end
echo.
pause
endlocal

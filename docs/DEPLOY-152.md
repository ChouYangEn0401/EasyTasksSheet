# 架到實驗室 152 server（Windows + nginx + NSSM）

| 項目       | 值                                                                                     |
| ---------- | -------------------------------------------------------------------------------------- |
| 對外網址   | `https://140.112.180.152/easytasks/`（走 nginx 443，三個校內網段限定，與其他服務相同） |
| 後端       | `127.0.0.1:8100`（只聽本機）。3000 = Gitea、8000 = pyDMS、8001 保留給 pydms-test       |
| 程式資料夾 | `C:\EasyTasksSheet`（下面的指令都以此為例；腳本會自動用所在的專案路徑）               |
| 服務       | NSSM 服務 `easytasks`，執行 `.venv\Scripts\python.exe main.py`                         |
| 資料       | `data\app.db`（SQLite）與 `data\attachments\`                                          |
| log        | `logs\easytasks.out.log`、`logs\easytasks.err.log`（10 MB 輪替）                       |

防火牆不用改：只走 nginx 的 443，8100 不需要任何放行規則（也**不要**加）。

## 專案裡的部署檔（`deploy\windows\`）

| 檔案 | 什麼時候用 |
| ---- | ---------- |
| `setup_easytasks.bat` | 第一次安裝，或 `.venv`／前端壞掉要重建時。建 `.venv` → 裝套件 → 建 `.env`（已有就不動）→ 建置前端 |
| `install_easytasks_service.bat` | 建立／重建 NSSM 服務。可加 `check` 只檢查 |
| `update_easytasks.bat` | 更新程式：先備份 → `git pull` → 套件 → 建置 → 重啟 → 健康檢查（建置失敗不會重啟） |
| `backup_easytasks.bat` | 備份資料庫與附件（給工作排程器用，也可手動跑） |
| `uninstall_easytasks_service.bat` | 移除服務（不刪資料） |
| `env.152.example` | 152 用的 `.env` 範本（`setup_easytasks.bat` 會自動複製） |
| `nginx-easytasks.conf` | 要貼進 152 `nginx.conf` 的 `/easytasks/` 段落 |
| `ensure-node.ps1` | 不用手動執行：建置時找不到 npm，由上面的腳本自動呼叫 |

152 server 自己的檔案（`C:\nginx\conf\nginx.conf`、`C:\nginx\html\jump_page.html`、`C:\scripts\*.bat`）**不放在本專案**，由 server 維護者管理。

## 需要的軟體

- Python 3.11 以上（152 已為 pyDMS 安裝；必須是「所有使用者」安裝）
- Git for Windows（152 已安裝）
- Node.js：**不用先裝**。建置前端時找不到 npm，腳本會自動下載官方免安裝版 Node.js 22 到 `.tools\node`（只給本專案建置用，不改系統；以官方 SHA256 驗證）。

## 第一次安裝（系統管理員 cmd）

1. 取得程式碼：

   ```bat
   git clone https://github.com/ChouYangEn0401/EasyTasksSheet.git C:\EasyTasksSheet
   ```

2. 準備環境：

   ```bat
   C:\EasyTasksSheet\deploy\windows\setup_easytasks.bat
   ```

   確認 `.env` 的部署值（**缺 `.env` 時程式會用預設的 3000，和 Gitea 衝突而無法啟動**）：

   ```bat
   findstr /B "NODE_ENV= HOST= PORT= BASE_PATH=" C:\EasyTasksSheet\.env
   ```

   要看到 `NODE_ENV=production`、`HOST=127.0.0.1`、`PORT=8100`、`BASE_PATH=/easytasks`。`BACKUP_DIR` 建議改到 C 槽以外。

3. 建立服務（先 check，再正式跑；正式跑要輸入 `YES`）：

   ```bat
   C:\EasyTasksSheet\deploy\windows\install_easytasks_service.bat check
   C:\EasyTasksSheet\deploy\windows\install_easytasks_service.bat
   ```

   結尾會驗證：服務 RUNNING、只綁 `127.0.0.1:8100`、`/api/health` 回 200。

4. nginx：把 `deploy\windows\nginx-easytasks.conf` 的段落貼進 `C:\nginx\conf\nginx.conf` 的 443 區塊（`error_page` 那行之前），先備份再檢查：

   ```bat
   copy C:\nginx\conf\nginx.conf C:\nginx\conf\nginx.conf.bak_easytasks
   cd /d C:\nginx
   nginx.exe -t
   nginx.exe -s reload
   ```

   `-t` 沒有出現 `test is successful` 就不要 reload，把 `.bak_easytasks` 複製回去。首頁導覽頁 `C:\nginx\html\jump_page.html` 另外加一張連到 `/easytasks/` 的卡片。

5. 從校內電腦開 `https://140.112.180.152/easytasks/`，用 `admin` / `password` 登入，會被要求改帳號與密碼。

6. 備份排程（每天 03:17，SYSTEM 帳號；不用停服務）：

   ```bat
   schtasks /Create /TN "EasyTasksSheet Backup" /TR "C:\EasyTasksSheet\deploy\windows\backup_easytasks.bat" /SC DAILY /ST 03:17 /RU SYSTEM /F
   schtasks /Run /TN "EasyTasksSheet Backup"
   type C:\EasyTasksSheet\logs\backup.log
   ```

   還原演練：`.venv\Scripts\python.exe -m server.cli backup --self-test`。

## 日常

| 要做的事 | 指令 |
| -------- | ---- |
| 更新程式 | `C:\EasyTasksSheet\deploy\windows\update_easytasks.bat` |
| 重啟     | `net stop easytasks` → `net start easytasks` |
| 看 log   | `powershell Get-Content C:\EasyTasksSheet\logs\easytasks.err.log -Tail 50 -Encoding UTF8` |
| 健康檢查 | `powershell (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8100/api/health).Content` → `{"ok":true,...}` |
| 新增帳號 | `cd /d C:\EasyTasksSheet` → `.venv\Scripts\python.exe -m server.cli user-add <帳號> --role user` |

## 錯誤判讀

先跑健康檢查與看 log，再對照下表。

| 看到的 | 原因 | 處理 |
| ------ | ---- | ---- |
| nginx 錯誤頁「An error occurred」（502） | 服務沒在跑或一直當掉 | `sc query easytasks`；看 `easytasks.err.log` |
| 服務狀態 `Paused`，log 有 `bind on address ('127.0.0.1', 3000)` | 沒有 `.env`（或 `PORT` 不是 8100），撞到 Gitea 的 3000 | `net stop easytasks` → 跑 `setup_easytasks.bat` 建 `.env` → `net start easytasks` |
| `/easytasks/` 空白頁，主控台 404 `/assets/...` | 前端沒建置，或建置時 `BASE_PATH` 不是 `/easytasks` | 確認 `.env` 後重跑 `setup_easytasks.bat`；後端啟動時也會在 log 印警告 |
| 建置時「下載 Node.js 失敗」 | 連不到 nodejs.org | 手動安裝 Node.js 22 LTS 後重開 cmd 再跑 |
| 登入後馬上被登出／修改都 403 | `APP_ORIGIN` 與瀏覽器網址不同 | `.env` 的 `APP_ORIGIN=https://140.112.180.152`（沒有結尾斜線、沒有路徑） |
| 畫面不會即時更新（要重整才看到） | nginx 緩衝了 SSE | `location /easytasks/` 要有 `proxy_buffering off;` |
| 所有人共用登入失敗次數 | `TRUSTED_PROXY` 不是 `true` | 改 `.env` 後重啟服務 |

## 其他電腦的同步與 worktree 回報（自簽憑證）

`python -m server.cli sync-push --server https://140.112.180.152/easytasks ...` 與 `scripts/report-worktrees.mjs` 都會驗證 HTTPS 憑證。
152 是自簽憑證，請在那台電腦把 152 的 `server.crt` 加入信任：Python 用環境變數 `SSL_CERT_FILE=<server.crt 路徑>`，Node 用 `NODE_EXTRA_CA_CERTS=<server.crt 路徑>`。憑證的 SAN 必須包含 `IP:140.112.180.152`。

## 子路徑是怎麼運作的（給維護者）

- `.env` 的 `BASE_PATH` 一個值控制三件事：前端建置的 `base`（`vite.config.ts`）、session cookie 的 `Path`、後端產生的附件網址。改了要重新建置。
- nginx 用結尾斜線的 `proxy_pass` 去掉前綴；後端另有 `StripBasePath`（`server/app/app.py`），直接連 `http://127.0.0.1:8100/easytasks/` 也能用。
- cookie 的 `Path=/easytasks`，不會和同網域的 Gitea、pyDMS 的 cookie 互相干擾。
- 本機開發不用 `.env` 也能跑（預設 `127.0.0.1:3000`、根目錄），152 則一定要有。

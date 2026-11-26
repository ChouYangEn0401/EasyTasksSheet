# 架到實驗室 152 server（Windows + nginx + NSSM）

把 EasyTasksSheet 加到 140.112.180.152，和 Gitea、pyDMS 用同一套做法：

| 項目       | 值                                                                                     |
| ---------- | -------------------------------------------------------------------------------------- |
| 對外網址   | `https://140.112.180.152/easytasks/`（走 nginx 443，三個校內網段限定，與其他服務相同） |
| 後端       | `127.0.0.1:8100`（只聽本機）。3000 = Gitea、8000 = pyDMS、8001 保留給 pydms-test       |
| 程式資料夾 | `C:\EasyTasksSheet`                                                                    |
| 服務       | NSSM 服務 `easytasks`，執行 `.venv\Scripts\python.exe main.py`                         |
| 資料       | `C:\EasyTasksSheet\data\app.db`（SQLite）與 `data\attachments\`                        |
| log        | `C:\EasyTasksSheet\logs\easytasks.out.log`、`easytasks.err.log`（10 MB 輪替）          |
| 腳本       | `C:\EasyTasksSheet\deploy\windows\*.bat`                                               |

> 防火牆不用改：只走 nginx 的 443，8100 不需要任何放行規則（也**不要**加）。

## 需要的軟體

- Python 3.11（152 已為 pyDMS 安裝；必須是「所有使用者」安裝）
- Git for Windows（152 已安裝）
- **Node.js 22 LTS**：只在建置前端（`npm run build`）時用到。不想在 152 裝 Node 的話，見文末「在開發電腦建置」。

## 第一次安裝

以下都在 152 的「系統管理員」cmd 執行。

1. 取得程式碼：

   ```bat
   git clone https://github.com/ChouYangEn0401/EasyTasksSheet.git C:\EasyTasksSheet
   ```

   之後若把倉庫搬到 152 的 Gitea，改用 `https://140.112.180.152/gitea/<owner>/EasyTasksSheet.git`（自簽憑證的處理見交接書 FAQ）。

2. 準備環境（建 `.venv`、安裝套件、由 `deploy\windows\env.152.example` 建立 `.env`、建置前端）：

   ```bat
   C:\EasyTasksSheet\deploy\windows\setup_easytasks.bat
   ```

   跑完用記事本確認 `C:\EasyTasksSheet\.env`，至少看 `BACKUP_DIR`（建議放 C 槽以外）。四個部署值必須是：
   `HOST=127.0.0.1`、`PORT=8100`、`BASE_PATH=/easytasks`、`TRUSTED_PROXY=true`。

3. 註冊 NSSM 服務（先 check，再正式跑；正式跑要輸入 `YES`）：

   ```bat
   C:\EasyTasksSheet\deploy\windows\install_easytasks_service.bat check
   C:\EasyTasksSheet\deploy\windows\install_easytasks_service.bat
   ```

   結尾會驗證：服務 RUNNING、只綁 `127.0.0.1:8100`、`/api/health` 回 200，並印出 log 最後 15 行。

4. nginx 與首頁導覽頁：完整的新版在 [`deploy/windows/nginx.conf`](../deploy/windows/nginx.conf)（以交接書 6.1 的現況為底，pyDMS、Gitea 一行都沒改，只加 `/easytasks/`）與 [`deploy/windows/jump_page.html`](../deploy/windows/jump_page.html)（多一張卡片）。用腳本套用：

   ```bat
   C:\EasyTasksSheet\deploy\windows\apply_nginx.bat check
   C:\EasyTasksSheet\deploy\windows\apply_nginx.bat
   ```

   `check` 只列出設定行的差異：應該**只有「+ 新增」的 EasyTasksSheet 幾行、沒有任何「- 移除」**。有「- 移除」代表 152 上的 nginx.conf 和交接書記錄的不同，先停下來。正式跑會備份兩個檔（`.bak_時間`）→ 換上 → `nginx -t` → 通過才 `-s reload`；沒通過自動還原。

5. （已併入第 4 步）

6. 從校內電腦開 `https://140.112.180.152/easytasks/`，用 `admin` / `password` 登入，會被要求改帳號與密碼。

7. 備份排程（每天 03:17，SYSTEM 帳號；不用停服務）：

   ```bat
   schtasks /Create /TN "EasyTasksSheet Backup" /TR "C:\EasyTasksSheet\deploy\windows\backup_easytasks.bat" /SC DAILY /ST 03:17 /RU SYSTEM /F
   schtasks /Run /TN "EasyTasksSheet Backup"
   type C:\EasyTasksSheet\logs\backup.log
   ```

   還原演練：`.venv\Scripts\python.exe -m server.cli backup --self-test`。

## 日常

| 要做的事 | 指令 |
| -------- | ---- |
| 更新程式 | `deploy\windows\update_easytasks.bat`（先備份 → `git pull --ff-only` → 套件 → 建置 → 重啟 → 健康檢查；建置失敗不會重啟） |
| 重啟     | `net stop easytasks` → `net start easytasks` |
| 看 log   | `powershell Get-Content C:\EasyTasksSheet\logs\easytasks.err.log -Tail 50 -Encoding UTF8` |
| 健康檢查 | `powershell (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8100/api/health).StatusCode` → 200 |
| 移除服務 | `deploy\windows\uninstall_easytasks_service.bat`（不刪資料） |
| 新增帳號 | `cd /d C:\EasyTasksSheet` → `.venv\Scripts\python.exe -m server.cli user-add <帳號> --role user` |

`C:\scripts` 的共用腳本要把 easytasks 一起納入（各加一行，放在 python-dms 那一行後面）：

| 腳本 | 要加的行 |
| ---- | -------- |
| `services_restarter.bat` | `net stop easytasks` 與 `net start easytasks` |
| `services_terminator.bat` | `net stop easytasks` |
| `backup.bat` | 不用改 `backup.bat`；EasyTasksSheet 由上面的排程自己備份（SQLite 線上備份，不需停服務） |

## 錯誤判讀

| 看到的 | 原因 | 處理 |
| ------ | ---- | ---- |
| `/easytasks/` 是空白頁，主控台 404 `/assets/...` | 前端建置時 `BASE_PATH` 不是 `/easytasks` | 確認 `.env` 後重新 `npm run build`；後端啟動時也會在 log 印警告 |
| nginx 502 | 服務沒在跑 | `sc query easytasks`、看 `easytasks.err.log` |
| 登入後馬上被登出／修改都 403 | `APP_ORIGIN` 與瀏覽器網址不同 | `.env` 的 `APP_ORIGIN=https://140.112.180.152`（沒有結尾斜線、沒有路徑） |
| 畫面不會即時更新（要重整才看到） | nginx 緩衝了 SSE | `location /easytasks/` 要有 `proxy_buffering off;` |
| 上傳附件 413 | nginx 上傳上限 | `client_max_body_size 256m;` |
| 所有人共用登入失敗次數 | `TRUSTED_PROXY` 不是 `true` | 改 `.env` 後重啟服務 |

## 其他電腦的同步與 worktree 回報（自簽憑證）

`python -m server.cli sync-push --server https://140.112.180.152/easytasks ...` 與 `scripts/report-worktrees.mjs` 都會驗證 HTTPS 憑證。
152 是自簽憑證，請在那台電腦把 152 的 `server.crt` 加入信任：Python 用環境變數 `SSL_CERT_FILE=<server.crt 路徑>`，Node 用 `NODE_EXTRA_CA_CERTS=<server.crt 路徑>`。憑證的 SAN 必須包含 `IP:140.112.180.152`（交接書「憑證」一節有檢查指令）。

## 在開發電腦建置（152 不裝 Node 時）

前端的網址前綴是建置時寫死的，所以要用相同的 `BASE_PATH` 建置：

```bash
BASE_PATH=/easytasks npm run build      # Windows PowerShell：$env:BASE_PATH="/easytasks"; npm run build
```

把產生的 `dist\web` 整個複製到 152 的 `C:\EasyTasksSheet\dist\web`，再 `net stop easytasks` → `net start easytasks`。此時 `update_easytasks.bat` 的建置步驟會失敗，請改成手動流程。

## 子路徑是怎麼運作的（給維護者）

- `.env` 的 `BASE_PATH` 一個值控制三件事：前端建置的 `base`（`vite.config.ts`）、session cookie 的 `Path`、後端產生的附件網址。
- nginx 用結尾斜線的 `proxy_pass` 去掉前綴；後端另有 `StripBasePath`（`server/app/app.py`），直接連 `http://127.0.0.1:8100/easytasks/` 也能用，所以 nginx 去不去前綴都可以。
- cookie 的 `Path=/easytasks`，不會和同網域的 Gitea、pyDMS 的 cookie 互相干擾。

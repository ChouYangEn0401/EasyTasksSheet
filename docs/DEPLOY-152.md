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
| `setup_easytasks.bat` | 第一次安裝，或 `.venv` 壞掉要重建時。建 `.venv` → 裝套件 → 建 `.env`（已有就不動）→ 建 `data`／`logs`／`backups`。前端是 `web\` 底下的靜態檔，不用建置 |
| `install_easytasks_service.bat` | 建立／重建 NSSM 服務。可加 `check` 只檢查（會確認 `web\index.html` 在、`.env` 的部署值正確） |
| `update_easytasks.bat` | 更新程式：先備份 → `git pull --ff-only` → 套件 → 重啟 → 健康檢查（任何一步失敗就停、不重啟）。沒有建置步驟 |
| `backup_easytasks.bat` | 備份資料庫與附件（給工作排程器用，也可手動跑） |
| `allow_restore.bat` | 開啟 30 分鐘的「還原解鎖」，讓 root 能在網頁上用整站搬家包覆蓋已有資料（加 `revoke` 立即關閉） |
| `uninstall_easytasks_service.bat` | 移除服務（不刪資料） |
| `env.152.example` | 152 用的 `.env` 範本（`setup_easytasks.bat` 會自動複製） |
| `nginx-easytasks.conf` | 要貼進 152 `nginx.conf` 的 `/easytasks/` 段落 |

152 server 自己的檔案（`C:\nginx\conf\nginx.conf`、`C:\nginx\html\jump_page.html`、`C:\scripts\*.bat`）**不放在本專案**，由 server 維護者管理。

## 需要的軟體

- Python 3.11 以上（152 已為 pyDMS 安裝；必須是「所有使用者」安裝）
- Git for Windows（152 已安裝）
- **不需要 Node.js**（2.0 起）。1.x 時期腳本會自動下載免安裝版 Node 到 `.tools\node` 來建置前端；從 1.x 升上來的 152 若還留著 `.tools\`、`dist\`、`node_modules\`，都已用不到，可以手動刪除。

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
   findstr /B "NODE_ENV= APP_ENV= HOST= PORT= BASE_PATH=" C:\EasyTasksSheet\.env
   ```

   要看到 `NODE_ENV=production`、`HOST=127.0.0.1`、`PORT=8100`、`BASE_PATH=/easytasks`。（152 的範本 `env.152.example` 沿用舊名 `NODE_ENV`，程式視同 `APP_ENV`；`install_easytasks_service.bat check` 目前檢查的也是這一行，所以 152 上請保留它。）`BACKUP_DIR` 建議改到 C 槽以外。

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

## 把本機的資料搬到 152（整站搬家包）

帳號密碼、任務、設定、附件會整份帶過去。設計與安全說明見 [design/site-pack.md](design/site-pack.md)。

1. 本機：用 root 登入 → 資料管理 → **整站搬家包 → 建立整站搬家包** → 再輸入一次密碼。
2. 畫面會顯示 8 個英文單字的**解鎖密語（只顯示一次）**：按「複製密語」存到安全的地方（和檔案分開放），再按「下載搬家包」得到 `easytasks-<時間>.etpack`。
3. 152 是**全新安裝**（還沒有人完成首次登入）：打開 `https://140.112.180.152/easytasks/login` → 「全新安裝？從整站搬家包還原」→ 選檔、貼上密語 → 還原 → 用本機的帳號密碼登入。
4. 152 **已經有資料**，要整份覆蓋：
   1. 用遠端桌面登入 152，執行 `C:\EasyTasksSheet\deploy\windows\allow_restore.bat`（開啟 30 分鐘的還原解鎖；只能在 152 本機開）。
   2. 用 root 登入網頁 → 資料管理 → 整站搬家包 →「我已開啟，重新檢查」→ 選檔、貼上密語、輸入自己的密碼與「取代全部」→ 取代全部資料。
   3. 還原前的資料會自動備份到 `.env` 的 `BACKUP_DIR`（`app-before-pack-restore-<時間>.db`），需要時可用 `python -m server.cli restore` 換回。

檔案大於 nginx 的上傳上限（目前 256 MB）時，把檔案複製到 152 後改用指令：

```bat
cd /d C:\EasyTasksSheet
net stop easytasks
.venv\Scripts\python.exe -m server.cli pack-import C:\EasyTasksSheet\backups\easytasks-<時間>.etpack --replace --yes
net start easytasks
```

（全新的 152 不需要 `--replace --yes`；密語會在執行時詢問，不會顯示在畫面上。）

## 日常

| 要做的事 | 指令 |
| -------- | ---- |
| 更新程式 | `C:\EasyTasksSheet\deploy\windows\update_easytasks.bat` |
| 重啟     | `net stop easytasks` → `net start easytasks` |
| 看 log   | `powershell Get-Content C:\EasyTasksSheet\logs\easytasks.err.log -Tail 50 -Encoding UTF8` |
| 健康檢查 | `powershell (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8100/api/health).Content` → `{"ok":true,...}` |
| 新增帳號 | `cd /d C:\EasyTasksSheet` → `.venv\Scripts\python.exe -m server.cli user-add <帳號> --role user` |

### 從 1.x（要 Node 的版本）升到 2.0

1. 照常跑 `update_easytasks.bat`（它會先備份 `data\app.db`；資料格式沒變，舊資料直接沿用）。
2. 健康檢查的回應裡會有 `"version":"2.0.0"`；網頁側欄底部也看得到版本。
3. 確認沒問題後，可以手動刪掉用不到的 `C:\EasyTasksSheet\dist\`、`node_modules\`、`.tools\`。
4. 如果 152 上曾為本專案另外安裝系統 Node.js，也可以移除（先確認沒有別的服務在用）。

## 錯誤判讀

先跑健康檢查與看 log，再對照下表。

| 看到的 | 原因 | 處理 |
| ------ | ---- | ---- |
| nginx 錯誤頁「An error occurred」（502） | 服務沒在跑或一直當掉 | `sc query easytasks`；看 `easytasks.err.log` |
| 服務狀態 `Paused`，log 有 `bind on address ('127.0.0.1', 3000)` | 沒有 `.env`（或 `PORT` 不是 8100），撞到 Gitea 的 3000 | `net stop easytasks` → 跑 `setup_easytasks.bat` 建 `.env` → `net start easytasks` |
| `/easytasks/` 空白頁，主控台 404 `/static/...` | `.env` 的 `BASE_PATH` 不是 `/easytasks`，或 nginx 的 `location` 沒對上 | 改 `.env` 後重啟服務（**不用重建**，`index.html` 每次請求代入 `BASE_PATH`）；再對照 `nginx-easytasks.conf` |
| 服務起不來，log 有「找不到前端 …web\index.html」 | 專案資料夾不完整 | `git status` 確認 `web\` 在；必要時重新 `git pull` 或重新 clone |
| 更新後畫面還是舊的 | 瀏覽器快取了舊的 `index.html` 以外的東西（少見） | `Ctrl+Shift+R` 強制重新整理；靜態檔網址帶版本段，服務重啟後就會換新 |
| 登入後馬上被登出／修改都 403 | `APP_ORIGIN` 與瀏覽器網址不同 | `.env` 的 `APP_ORIGIN=https://140.112.180.152`（沒有結尾斜線、沒有路徑） |
| 畫面不會即時更新（要重整才看到） | nginx 緩衝了 SSE | `location /easytasks/` 要有 `proxy_buffering off;` |
| 所有人共用登入失敗次數 | `TRUSTED_PROXY` 不是 `true` | 改 `.env` 後重啟服務 |

## 其他電腦的同步與 worktree 回報（自簽憑證）

`python -m server.cli sync-push --server https://140.112.180.152/easytasks ...` 與 `python scripts/report_worktrees.py --server https://140.112.180.152/easytasks ...` 都會驗證 HTTPS 憑證。
152 是自簽憑證，請在那台電腦把 152 的 `server.crt` 加入信任：設環境變數 `SSL_CERT_FILE=<server.crt 路徑>`（兩支都是 Python，同一個變數就夠；1.x 的 Node 回報腳本才需要 `NODE_EXTRA_CA_CERTS`）。憑證的 SAN 必須包含 `IP:140.112.180.152`。

## 子路徑是怎麼運作的（給維護者）

- `.env` 的 `BASE_PATH` 一個值控制三件事：前端的網址前綴（伺服器每次回 `index.html` 時把 `{{BASE}}`、`{{STATIC}}` 代入，見 [frontend.md](frontend.md)）、session cookie 的 `Path`、後端產生的附件網址。**改了只要重啟服務**（1.x 時要重新建置前端，2.0 起不用）。
- nginx 用結尾斜線的 `proxy_pass` 去掉前綴；後端另有 `StripBasePath`（`server/app/app.py`），直接連 `http://127.0.0.1:8100/easytasks/` 也能用。
- cookie 的 `Path=/easytasks`，不會和同網域的 Gitea、pyDMS 的 cookie 互相干擾。
- 本機開發不用 `.env` 也能跑（預設 `127.0.0.1:3000`、根目錄），152 則一定要有。

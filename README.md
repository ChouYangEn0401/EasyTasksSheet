# TasksSheets — 實驗室專案管理工具

給實驗室內部使用的多人任務 / 專案管理網站。單一 Python 行程（FastAPI + uvicorn）同時提供 API 與前端靜態檔，資料存在一個 SQLite 檔，部署與備份都很簡單。

## 快速開始（純 Python 執行）

專案的 Python 進入點是根目錄的 [`main.py`](main.py)：

```bash
python -m venv .venv                       # 建立虛擬環境
.venv/Scripts/activate                     # Windows（Linux / macOS：source .venv/bin/activate）
pip install -r requirements.txt            # 安裝後端相依套件
cp .env.example .env                       # 可選；Windows PowerShell：Copy-Item .env.example .env
python main.py --prod                      # 啟動，開啟 http://localhost:3000
```

> 預設只綁 `127.0.0.1`，只有本機連得上，請開 `http://localhost:3000`。要讓同一網路的其他電腦連線，在 `.env` 設 `HOST=0.0.0.0`，其他人再開 `http://<這台電腦的 IP>:3000`（注意：**瀏覽器不能開 `0.0.0.0` 這個位址**，會出現 `ERR_ADDRESS_INVALID`）。

- 前端已建置在 `dist/web`；若是第一次取得原始碼或改了前端，需先 `npm ci && npm run build`（Node 只用在建置前端）。
- 第一次啟動會自動建立資料庫與預設管理員，帳號與密碼會印在主控台（或由 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 指定），首次登入要先改密碼。
- 開發時用 `python main.py --reload`（後端自動重載）；管理指令（新增帳號、備份、還原）用 `python -m server.cli --help`。
- 後端程式碼在 [`server/app/`](server/app)：`main.py` 組裝應用、`app.py` 掛路由、`features/` 每個功能一個檔案、`migrations/` 放資料表 SQL。

## 功能簡介

- **任務檢視**：List（就地編輯、快速新增、自訂欄位、任務詳情抽屜）、Kanban（拖曳改狀態與排序）、Gantt 與總覽主畫面、月曆排程。
- **即時同步**：多人同時編輯時以 SSE（`/api/events`）即時更新，斷線自動重連並退回輪詢。
- **問題回饋**：回饋清單，集中收集成員回報的問題。
- **個人頁**：我的任務、釘選項目。
- **工程追蹤**：手動記錄問題與 worktree 狀態；可選擇讓各人電腦自動回報 worktree（見「工程追蹤的使用方式」）。
- **成員管理**：管理員新增成員（臨時密碼、首次登入強制改密碼）、停用 / 啟用、重設密碼、調整角色、解除登入鎖定。
- **安全**：Argon2 密碼雜湊、session 絕對期限與閒置逾時、登入失敗鎖定、CSRF（Origin 檢查 + SameSite cookie）。

技術：後端 Python 3.11+（FastAPI、uvicorn、標準庫 `sqlite3`，WAL 模式）；前端 React + Vite（TypeScript）。

## 需求

| 項目     | 版本 / 說明                                                                    |
| -------- | ------------------------------------------------------------------------------ |
| Python   | **3.11 以上**（執行後端與管理指令）                                            |
| Node.js  | 22.18 以上，**只用於建置前端**（`npm run build`）與本機開發；正式執行不需要    |
| 作業系統 | Linux（正式環境建議 Debian / Ubuntu）；Windows、macOS 可開發                   |
| 反向代理 | Caddy v2（範例見 `deploy/Caddyfile`），負責 HTTPS                              |

Python 相依套件見 `server/requirements.txt`（皆有預編譯 wheel，不需編譯工具）。

## 本機開發

```bash
npm ci                        # 前端相依套件
npm run py:install            # 建立 .venv 並安裝 server/requirements.txt
cp .env.example .env          # Windows PowerShell：Copy-Item .env.example .env
npm run dev                   # 後端 uvicorn :3000（自動重載）+ Vite :5173（/api 由 Vite 代理到後端）
```

開啟 <http://localhost:5173>。後端啟動時會自動建立資料庫、套用 migration 並寫入預設資料；若沒有任何帳號，會建立管理員（見「預設管理員與首次改密碼」），主控台會顯示帳密資訊。

常用指令：

| 指令                                                     | 說明                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run py:test`                                        | 後端測試（pytest）                                         |
| `npm run build`                                          | 建置前端到 `dist/web`                                      |
| `npm run dev:py`                                         | 只啟動後端（`python -m server.app --reload`）              |
| `python -m server.app`                                   | 以 `.env` 的 `HOST` / `PORT` 啟動後端（正式模式同時提供前端） |
| `python -m server.cli user-add <帳號> [--admin]`         | 從命令列新增帳號（未給密碼則產生並顯示一次）               |
| `python -m server.cli backup`                            | 備份資料庫（見「備份與還原」）                             |

> `python` 指 `.venv` 內的 Python：Linux / macOS 為 `.venv/bin/python`，Windows 為 `.venv\Scripts\python.exe`（或先啟用 venv）。所有指令都在專案根目錄執行，會讀取該目錄的 `.env`。

## 環境變數

全部寫在專案根目錄的 `.env`（範本：`.env.example`），程式從**工作目錄**讀取。已存在的系統環境變數優先；空值視同未設定。定義見 `server/app/config.py`。

| 變數                       | 預設            | 說明                                                                                                |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `development`   | 沿用的名稱。正式環境設 `production`：提供前端靜態檔、cookie 預設加 `Secure`                        |
| `HOST`                     | `127.0.0.1`     | 監聽位址，預設只有本機能連。要讓區網其他電腦直接連才改 `0.0.0.0`；搭配反向代理時維持 `127.0.0.1` |
| `PORT`                     | `3000`          | 後端連接埠                                                                                          |
| `WEB_PORT`                 | `5173`          | 僅開發用（Vite）                                                                                    |
| `APP_ORIGIN`               | （空）          | 對外網址，例如 `https://tasks.lab.example`。設定後修改類請求只接受此 Origin；未設定則與 `Host` 比對 |
| `DATABASE_PATH`            | `data/app.db`   | SQLite 檔路徑（相對於工作目錄）                                                                     |
| `STATIC_DIR`               | `dist/web`      | 正式模式的前端檔目錄                                                                                |
| `TZ`                       | `Asia/Taipei`   | 時區                                                                                                |
| `SESSION_MAX_HOURS`        | `9`             | 登入絕對期限（小時，不續期）                                                                        |
| `SESSION_IDLE_MINUTES`     | `60`            | 閒置自動登出（分鐘）                                                                                |
| `COOKIE_SECURE`            | 正式環境 `true` | cookie `Secure` 旗標。只有在**沒有 HTTPS** 的臨時測試才設 `false`                                   |
| `LOGIN_WINDOW_MINUTES`     | `15`            | 登入失敗計數視窗                                                                                    |
| `LOGIN_MAX_FAILS_PER_USER` | `5`             | 同帳號失敗幾次後鎖定                                                                                |
| `LOGIN_LOCK_MINUTES`       | `15`            | 帳號鎖定時間                                                                                        |
| `LOGIN_MAX_FAILS_PER_IP`   | `20`            | 同 IP 失敗幾次後暫拒                                                                                |
| `TRUSTED_PROXY`            | `false`         | 經 Caddy/nginx 反向代理時**必須設 `true`**（取 `X-Forwarded-For` 最右段）；直連 uvicorn 維持 `false`（忽略該標頭，避免偽造） |
| `ADMIN_USERNAME`           | `admin`         | 首次啟動（尚無帳號時）建立的管理員帳號                                                              |
| `ADMIN_PASSWORD`           | （空）          | 首次管理員密碼；空白則隨機產生並**只在主控台顯示一次**                                              |
| `CHANGES_RETENTION_DAYS`   | `30`            | 變更流水保留天數（即時同步用）                                                                      |
| `WORKTREE_REPORT_TOKEN`    | （空）          | 各人電腦回報 worktree 用的 token；空白 = 停用回報端點（一律 403）                                   |
| `BACKUP_DIR`               | `backups`       | 備份目錄（`python -m server.cli backup` 使用；建議放在不同磁碟）                                    |
| `BACKUP_KEEP`              | `14`            | 保留最近幾份備份                                                                                    |

## 從零部署（Linux + systemd + Caddy）

以下以 Debian / Ubuntu、安裝到 `/opt/tasks-sheets`、主機名稱 `tasks.lab.example` 為例。服務僅供實驗室內網或 VPN 存取。

### 1. 安裝 Python、Node.js（建置用）與 Caddy

```bash
sudo apt-get install -y python3 python3-venv git     # 確認 python3 --version >= 3.11
# Node.js 22（只用來建置前端；也可在別台機器 build 後把 dist/web 複製過來）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
# Caddy（官方套件庫，指令見 https://caddyserver.com/docs/install#debian-ubuntu-raspbian）
sudo apt-get install -y caddy
```

### 2. 取得程式、建立 venv、建置前端

```bash
sudo useradd --system --home /opt/tasks-sheets --shell /usr/sbin/nologin tasks-sheets
sudo git clone <repo-url> /opt/tasks-sheets
cd /opt/tasks-sheets
sudo mkdir -p data backups
sudo chown -R tasks-sheets:tasks-sheets /opt/tasks-sheets

sudo -u tasks-sheets python3 -m venv .venv
sudo -u tasks-sheets .venv/bin/pip install -r server/requirements.txt
sudo -u tasks-sheets npm ci                 # 前端建置工具
sudo -u tasks-sheets npm run build          # 產生 dist/web
```

### 3. 設定 `.env`

```bash
sudo -u tasks-sheets cp .env.example .env
sudo -u tasks-sheets chmod 600 .env
sudo -u tasks-sheets nano .env
```

正式環境至少修改：

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://tasks.lab.example
# 經 Caddy/nginx 反向代理時必須為 true（否則所有人共用 127.0.0.1 這個登入失敗 IP 桶）
TRUSTED_PROXY=true
DATABASE_PATH=data/app.db
ADMIN_USERNAME=admin
# 建議留空讓系統產生隨機密碼（見「預設管理員」）；若要指定，首次登入後仍會被要求更改
ADMIN_PASSWORD=
BACKUP_DIR=backups
BACKUP_KEEP=14
```

`COOKIE_SECURE` 留空即可（正式環境自動為 `true`）。`.env` 已列入 `.gitignore`，不可提交。

### 4. 手動啟動確認

```bash
sudo -u tasks-sheets .venv/bin/python -m server.app     # 依 .env 的 HOST / PORT 啟動；Ctrl+C 結束
curl http://127.0.0.1:3000/api/health                   # 另開終端機：{"ok":true,...}
```

啟動時會自動建立資料庫並套用尚未執行的 migration，不需另外初始化。

### 5. 以 systemd 常駐

```bash
sudo cp deploy/tasks-sheets.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tasks-sheets
sudo systemctl status tasks-sheets
curl http://127.0.0.1:3000/api/health
```

`deploy/tasks-sheets.service` 重點：

- `ExecStart=/opt/tasks-sheets/.venv/bin/python -m uvicorn server.app.main:app --host 127.0.0.1 --port ${PORT} --no-proxy-headers --timeout-graceful-shutdown 3`：一律只綁 `127.0.0.1`；`--timeout-graceful-shutdown` 讓 SSE 長連線不會卡住重啟。
- **只能單一 worker**（不要加 `--workers`）：即時同步的事件中樞與 SQLite 連線在同一個行程內。
- `EnvironmentFile=/opt/tasks-sheets/.env`；注意它會覆寫 unit 內的 `Environment=`，所以 `.env` 必須設 `NODE_ENV=production`。
- `ProtectSystem=strict`，只允許寫入 `data/` 與 `backups/`，兩個目錄必須事先存在，否則服務無法啟動。安裝路徑不同時請修改 unit 檔內所有 `/opt/tasks-sheets`。

### 6. 反向代理與 HTTPS（Caddy）

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile             # 改主機名稱、選擇憑證方式
sudo systemctl reload caddy
```

`deploy/Caddyfile` 重點：

- **憑證**：內網無公開 DNS 時用 `tls internal`（Caddy 內建 CA），再把根憑證 `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` 發給成員安裝信任；有校方憑證則改用 `tls <crt> <key>`；可從網際網路解析的主機刪掉 `tls` 行即自動申請 Let's Encrypt。
- **SSE（`/api/events`）**：`flush_interval -1` 關閉緩衝、`read_timeout 0` / `write_timeout 0` 不設逾時、不套用壓縮；`stream_close_delay 5m` 讓重新載入設定時既有連線不會同時斷線。若改用其他反向代理，請務必做等效設定（見「常見問題」）。
- 其他路徑全部轉給同一個 uvicorn 行程（API + 前端靜態檔 + SPA 路由回退）。

開啟 `https://tasks.lab.example` 確認可看到登入頁。

### 7. 每日備份

```bash
sudo cp deploy/tasks-sheets-backup.service deploy/tasks-sheets-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tasks-sheets-backup.timer
sudo systemctl start tasks-sheets-backup    # 立即跑一次確認
journalctl -u tasks-sheets-backup -n 20
ls -l /opt/tasks-sheets/backups
```

每天 03:00 執行 `python -m server.cli backup`，保留 `BACKUP_KEEP` 份。建議再用 rsync / 校內 NAS 把 `backups/` 同步到另一台機器。

### （可選）Docker Compose

`deploy/Dockerfile` 為多階段建置：`node:22` 建置前端 → `python:3.11-slim` 以 uvicorn 執行（映像內不含 Node）。

```bash
cp .env.example .env                        # 依上面步驟 3 修改（路徑類設定會被 compose 覆寫）
SITE_ADDRESS=tasks.lab.example docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs app | grep '初始密碼'
docker compose -f deploy/docker-compose.yml exec app python -m server.cli backup   # 備份
```

資料在 volume `tasks-data`，備份在 `tasks-backups`；`tls internal` 的根憑證在 caddy 容器的 `/data/caddy/pki/authorities/local/root.crt`。還原方式見 `deploy/docker-compose.yml` 開頭註解。

## 預設管理員與首次改密碼

- 資料庫中**還沒有任何帳號**時，第一次啟動會建立管理員 `ADMIN_USERNAME`（預設 `admin`）。
- `ADMIN_PASSWORD` 留空時會產生隨機密碼，**只在啟動紀錄顯示一次**：

  ```bash
  sudo journalctl -u tasks-sheets | grep '初始密碼'
  ```

- 管理員第一次登入會被要求更改密碼。改完後若 `.env` 有填 `ADMIN_PASSWORD`，請把它清空（之後不會再被使用）。
- 其他成員由管理員在「成員管理」頁新增（給臨時密碼，對方首次登入需改密碼），或在主機上執行：

  ```bash
  cd /opt/tasks-sheets
  sudo -u tasks-sheets .venv/bin/python -m server.cli user-add <帳號> [--name 顯示名稱] [--admin]
  ```

## 備份與還原

`python -m server.cli backup` 以 SQLite 的 `VACUUM INTO` 在**服務運行中**產生一致的快照（單一讀取交易，包含尚未 checkpoint 的 WAL 內容），先寫成 `.partial`，以 `PRAGMA integrity_check` 驗證通過後才改名；輸出為不依賴 `-wal` / `-shm` 的單一 `.db` 檔。超過保留份數的最舊備份會自動刪除（只刪除符合 `<資料庫名>-YYYYMMDD-HHMMSS.db` 的檔案）。Windows 與 Linux 皆可執行。

```bash
# 備份（不需停機）；參數皆可省略，預設取 .env 的 DATABASE_PATH / BACKUP_DIR / BACKUP_KEEP
.venv/bin/python -m server.cli backup [--db data/app.db] [--out backups] [--keep 14]
# → backups/app-20261125-030000.db

# 自我測試（暫存目錄內演練 備份 → 保留份數 → 還原 → 驗證）
.venv/bin/python -m server.cli backup --self-test
```

### 還原步驟

1. 停止服務：`sudo systemctl stop tasks-sheets`
2. 還原（必須加 `--yes`，否則拒絕執行）：

   ```bash
   cd /opt/tasks-sheets
   sudo -u tasks-sheets .venv/bin/python -m server.cli restore backups/app-20261125-030000.db --yes
   ```

   指令會先驗證備份檔完整性（損毀則中止、不動到現有資料庫），把目前的資料庫 checkpoint 後改名為 `app.db.before-restore-<時間>` 保留，刪除殘留的 `-wal` / `-shm`，再放入備份。

3. 啟動服務：`sudo systemctl start tasks-sheets`，登入確認資料。
4. 確認無誤後刪除 `data/app.db.before-restore-*`。若還原有誤，停止服務後把它改名回 `app.db` 即可回退。

也可以手動還原：停止服務 → 刪除 `app.db-wal`、`app.db-shm` → 用備份檔覆蓋 `app.db` → 啟動。

### 還原演練紀錄（2026-11-25，Windows 11，Python 3.11.9 / SQLite 3.45.1）

在暫存目錄以正式模式實際跑過一次：

1. `npm run build`；以 `NODE_ENV=production`、`HOST=127.0.0.1`、`DATABASE_PATH=<暫存>/data/app.db` 啟動 `python -m server.app`。
2. 確認 `/` 回傳前端 `index.html`、`/some/deep/link` 回退到同一頁（SPA）。
3. 以管理員登入，透過 API 新增 3 個專案（連同預設專案共 4 個），記錄 `GET /api/projects` 結果。
4. **服務運行中**執行 `python -m server.cli backup --out <暫存>/backups --keep 7`，產生 `app-20261125-025344.db`。
5. 備份後再新增 1 個專案（共 5 個）——這筆應在還原後消失。
6. 停止服務（強制結束行程，WAL 檔仍在）；`restore` 未加 `--yes` 時拒絕執行（exit 1）；加 `--yes` 後還原成功，舊檔保留為 `app.db.before-restore-20261125-025344`。
7. 重新啟動、登入，`GET /api/projects` 與步驟 3 的結果**完全相同**（4 個，備份後新增的那筆不在）。

另外 `python -m server.cli backup --self-test` 會在暫存目錄模擬「連線開著、資料仍在 WAL 中」的運行狀態，驗證備份內容一致、保留份數清除、還原後資料一致且可繼續寫入、損毀備份檔會被拒絕；`server/tests/test_backup.py` 以真實 schema 涵蓋相同情境與 CLI 行為。

## 升級流程

```bash
cd /opt/tasks-sheets
sudo systemctl start tasks-sheets-backup                               # 1. 先備份
sudo -u tasks-sheets git pull                                          # 2. 取得新版
sudo -u tasks-sheets .venv/bin/pip install -r server/requirements.txt  # 3. 更新 Python 套件
sudo -u tasks-sheets npm ci && sudo -u tasks-sheets npm run build      # 4. 重建前端
sudo systemctl restart tasks-sheets                                    # 5. 重啟（啟動時自動套用新 migration）
sudo journalctl -u tasks-sheets -n 50                                  # 6. 確認無錯誤
```

若新版啟動失敗：`git checkout <舊版 tag/commit>` → 重新 `pip install` 與 `npm run build` → 依「還原步驟」還原升級前的備份（新版 migration 可能已改動資料庫結構）。

## 工程追蹤的使用方式

- **手動輸入為主**：「工程追蹤」頁的問題與 worktree 紀錄由成員直接新增 / 編輯 / 結案，狀態一律手動維護。伺服器端不執行任何 git 指令。
- **各人電腦自動回報（選用）**：在 `.env` 設定 `WORKTREE_REPORT_TOKEN`（夠長的隨機字串，例如 `python -c "import secrets; print(secrets.token_urlsafe(32))"`）並重啟服務；各人在自己的電腦（需 Node.js 與 git）執行：

  ```bash
  WORKTREE_REPORT_TOKEN=<同一個 token> node scripts/report-worktrees.mjs --server https://tasks.lab.example --path <repo 路徑>
  # PowerShell：$env:WORKTREE_REPORT_TOKEN='<token>'; node scripts/report-worktrees.mjs --server https://tasks.lab.example
  # 先看會送出什麼：加 --dry-run
  ```

  腳本會把本機 `git worktree list` 的快照（dirty / ahead / behind / 是否已併入 main）送到 `POST /api/eng/worktrees/report`，頁面上會與手動紀錄比對並提示「可能遺失 / 未登記」，僅供參考。腳本只依賴 Node 內建模組，可單獨複製到其他電腦；可用排程（cron / 工作排程器）定期執行。`GIT_TIMEOUT_MS` 環境變數可調整腳本內 git 指令逾時（預設 10000）。
- **GitHub 連動**：選配功能，見下方「選配：GitHub 連動」。

### 選配：GitHub 連動

沒設定 token 時完全不連網、畫面不出現 GitHub 按鈕，問題仍以手記為主。設定後：

- 問題的「連結」貼上 GitHub issue 網址（`https://github.com/<owner>/<repo>/issues/<n>`）→ 自動顯示 `#編號`，並定期同步狀態（GitHub 關閉 → 已結案、重開 → 未處理；GitHub 端沒變動時不覆蓋本地手動改的狀態）。
- 「GitHub 連動 / 匯入」：把專案名稱對應到 GitHub repo，可匯入開啟中的 issue（不重複建立）；問題的「⋯」選單可「在 GitHub 建立」。

在伺服器 `.env` 設定（token **只存在 server 的 `.env`**，不會傳到瀏覽器）並重啟服務：

| 變數                  | 預設                     | 說明                                                   |
| --------------------- | ------------------------ | ------------------------------------------------------ |
| `GITHUB_TOKEN`        | （空）                   | GitHub token；空白 = 停用 GitHub 連動                  |
| `GITHUB_API_URL`      | `https://api.github.com` | API 位址（GitHub Enterprise 可改）                     |
| `GITHUB_SYNC_MINUTES` | `5`                      | 開啟問題列表時，距上次同步超過幾分鐘就自動同步一次     |

token 權限：fine-grained token 選定相關 repo，**Issues：Read-only** 即可同步與匯入；要「在 GitHub 建立」則需 **Issues：Read and write**。classic token 用 `repo` 範圍（公開 repo 可用 `public_repo`）。

## 常見問題

**Q：登入後馬上又被登出 / 一直回到登入頁？**
正式模式 cookie 帶 `Secure`，必須經由 HTTPS 存取。直接用 `http://主機:3000` 測試時才把 `COOKIE_SECURE=false`。

**Q：存檔時出現 403「來源不被允許」？**
`APP_ORIGIN` 必須與瀏覽器網址列的來源完全相同（含 `https://`、不含結尾 `/`、非預設連接埠要寫出來）。不確定時可先留空。

**Q：忘記管理員密碼？**
由另一位管理員在成員管理頁重設；若沒有其他管理員，在主機上 `.venv/bin/python -m server.cli user-add <新帳號> --admin` 建立新管理員再處理。

**Q：首次啟動的隨機密碼沒看到？**
`journalctl -u tasks-sheets | grep 初始密碼`。若紀錄已被清除，可停服務、刪除資料庫重新初始化（僅限尚未有資料時），或用 `user-add --admin` 建立新管理員。

**Q：即時更新延遲、或每隔一段時間斷線？**
通常是反向代理緩衝或逾時。Caddy 請用 `deploy/Caddyfile` 的 `/api/events` 設定；nginx 需對該路徑設定：

```nginx
location /api/events {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    gzip off;
}
```

其他路徑的 `location /` 也要設定 `proxy_set_header Host $host;` 與 `proxy_set_header X-Forwarded-For $remote_addr;`（以 `$remote_addr` **覆寫**，不要用會附加用戶端值的 `$proxy_add_x_forwarded_for`）。即時同步的設計是 SSE 斷線時自動重連並退回輪詢，因此設定錯誤通常不會壞掉，只會變慢。

**Q：`systemctl restart` 很久才完成？**
確認 `ExecStart` 有 `--timeout-graceful-shutdown`（或使用 `python -m server.app`，已內建 3 秒）；否則 uvicorn 會等所有 SSE 連線結束。

**Q：為什麼後端只綁 `127.0.0.1`？**
登入失敗的 IP 限制在 `TRUSTED_PROXY=true` 時採用 `X-Forwarded-For` 最右段（由代理附加、用戶端無法偽造）；只讓 Caddy 連入可確保該標頭一定經過代理，也避免繞過 HTTPS。沒有反向代理時請維持 `TRUSTED_PROXY=false`，後端改用連線的 socket 位址並忽略該標頭。

**Q：可以開多個 uvicorn worker 嗎？**
不行。即時同步的事件中樞在行程記憶體內，多 worker 會讓部分使用者收不到更新。實驗室規模單一行程即足夠。

**Q：資料庫檔旁邊的 `app.db-wal`、`app.db-shm` 是什麼？可以刪嗎？**
WAL 模式的暫存檔，**服務運行中絕對不可刪除或單獨複製 `app.db`**（會遺失或損毀資料）。備份請一律用 `python -m server.cli backup`。

**Q：備份放哪裡比較好？**
`BACKUP_DIR` 指向另一顆磁碟或掛載的 NAS，並定期把備份複製到另一台機器。記得兩個 systemd unit 的 `ReadWritePaths` 也要加上該路徑。

# EasyTasksSheet（TasksSheets）— 實驗室專案管理工具

> **What it is.** EasyTasksSheet is a self-hosted, multi-user task and project tracker for small teams
> (a lab, a small company): list / kanban / Gantt views, task dependencies and delay chains, discussions,
> personal reports, audit log with one-click revert, and real-time sync. **The whole system is Python only** —
> one process (FastAPI + uvicorn) serves both the API and a no-build vanilla-JS frontend, and all data lives in one
> SQLite file. No Node.js, no npm, no build step.
>
> **Quick start** (Python 3.11+):
>
> ```bash
> git clone https://github.com/ChouYangEn0401/EasyTasksSheet && cd EasyTasksSheet
> python scripts/install.py          # creates .venv, installs requirements, copies .env
> .venv/bin/python main.py           # Windows: .venv\Scripts\python main.py
> # open http://localhost:3000 — first login: admin / password (you will be asked to change both)
> ```
>
> The rest of this README is in Traditional Chinese.

給實驗室（或小團隊、小公司）內部使用的多人任務 / 專案管理網站。**整個系統只有 Python**：單一行程（FastAPI + uvicorn）同時提供 API 與前端，前端是瀏覽器直接載入的原生 JavaScript（不需要 Node.js、npm，也沒有建置步驟），資料存在一個 SQLite 檔，安裝、部署與備份都很簡單。

目前版本見 [`server/app/version.py`](server/app/version.py)（介面側欄底部與 `/api/health` 也看得到），每一版改了什麼、資料格式有沒有變見 [CHANGELOG.md](CHANGELOG.md)。

## 快速開始

只需要 **Python 3.11 以上**與 git。在專案根目錄：

```bash
python scripts/install.py                  # 建 .venv、安裝套件、建 data/ logs/ backups/、沒有 .env 就從 .env.example 複製
.venv/bin/python main.py                   # 啟動（Windows：.venv\Scripts\python main.py），開啟 http://localhost:3000
```

> 預設只綁 `127.0.0.1`，只有本機連得上，請開 `http://localhost:3000`。要讓同一網路的其他電腦連線，在 `.env` 設 `HOST=0.0.0.0`，其他人再開 `http://<這台電腦的 IP>:3000`（注意：**瀏覽器不能開 `0.0.0.0` 這個位址**，會出現 `ERR_ADDRESS_INVALID`）。

- 第一次啟動會自動建立資料庫與預設管理員：帳號 `admin`、密碼 `password`。首次登入會被要求**重設帳號與密碼**（新帳號不可再用 `admin`）。
- `python main.py` 的選項：`--reload`（改了 `server/` 的程式自動重載，開發用）、`--prod`（正式模式，等同 `APP_ENV=production`）、`--port N`（這一次換埠，不改 `.env`）、`--host`、`--help`。
- 啟動前會先檢查埠：埠已被佔用（例如另一個實例已在跑）就**不碰資料庫**、直接印出原因結束。
- `--prod` 正式模式：登入 cookie 會要求 HTTPS（`Secure`），請搭配 Caddy / nginx 等反向代理使用；用純 http 在區網測試請不要加 `--prod`。
- 不想用安裝腳本也可以自己來：`python -m venv .venv` → `.venv/bin/pip install -r requirements.txt` → 複製 `.env.example` 成 `.env` → `.venv/bin/python main.py`。
- 管理指令（新增帳號、備份、還原、搬家包）：`python -m server.cli --help`。

## 文件導覽

| 文件                                                    | 內容                                                   |
| ------------------------------------------------------- | ------------------------------------------------------ |
| [CHANGELOG.md](CHANGELOG.md)                            | 每一版改了什麼、資料格式有沒有變、升級前要不要先備份   |
| [docs/HANDOFF.md](docs/HANDOFF.md)                      | 交接總覽：現況、程式地圖、已知問題、待決策、如何擴充   |
| [docs/frontend.md](docs/frontend.md)                    | 前端架構（原生 JS、無建置）、怎麼新增一頁、怎麼更新 Preact |
| [docs/MOVE-TO-SERVER.md](docs/MOVE-TO-SERVER.md)        | 把本機資料搬到 server 的逐步教學（整包搬 / JSON / 同步） |
| [docs/DEPLOY-152.md](docs/DEPLOY-152.md)                | 架到實驗室 152（Windows + nginx `/easytasks/` + NSSM 服務） |
| [docs/permissions.md](docs/permissions.md)              | 角色與權限矩陣                                         |
| [docs/design/task-discussion.md](docs/design/task-discussion.md) | 任務討論區（討論串、未讀、捲軸）與描述鎖定     |
| [docs/design/audit-log.md](docs/design/audit-log.md)    | 稽核紀錄與一鍵還原                                     |
| [docs/design/delay-link.md](docs/design/delay-link.md)  | 任務依賴與延遲鏈                                       |
| [docs/design/undo.md](docs/design/undo.md)              | 全站復原 / 重做                                        |
| [docs/multi-user.md](docs/multi-user.md)                | 多人同時使用、在線感知、限制                           |
| [docs/sync.md](docs/sync.md)                            | 多台電腦同步（sync-push）                              |
| [docs/product-principles.md](docs/product-principles.md) | 產品原則                                               |

## 功能簡介

- **總覽**：只呈現「列入總覽統計」的成員（超級管理員預設不列入，成員管理可調整），任務仍可指派給任何帳號。
- **相關任務與複製任務**：在任務詳情抽屜可把任務互相建立「相關」連結（清單與看板顯示 🔗 數量，點擊即跳轉），並可從「⋯」選單或按 `D` 複製任務（可選擇要帶過去的內容與狀態）。
- **復原 / 重做**：`Ctrl+Z` 復原、`Ctrl+Shift+Z`（或 `Ctrl+Y`）重做自己剛才的任務編輯、拖曳、新增與刪除（Mac 用 `Cmd`；在輸入框內為一般文字復原；重新整理後清空），頂欄也有按鈕；規則見 `docs/design/undo.md`。
- **任務檢視**：List（就地編輯、快速新增、自訂欄位、任務詳情抽屜；按住列左側把手可直接拖到別的狀態 / 負責人 / 專案群組或調整順序）、Kanban（拖曳改狀態與排序）、Gantt 與總覽主畫面、月曆排程。
- **待辦清單**：任務詳情抽屜內可勾選、可拖曳排序、可貼上多行建立的待辦清單；清單與看板顯示「☑ 3/5」進度徽章（規格見 `docs/design/task-list.md` §16）。
- **依賴與延遲鏈**：在任務詳情的「依賴」設定前置任務（哪件事要先完成）；看板以琥珀色標示「等待中」與預計延後天數，「延遲鏈」分頁（甘特圖後面）以由左到右的圖看整條「誰在等誰」的鏈與決定最終完成日的路徑。規則與推算公式見 [docs/design/delay-link.md](docs/design/delay-link.md)。
- **甘特圖拖曳排程**：「未排程」的任務可直接拖到時間軸上的某一天（預設 3 天，有預估工時則依工時換算；拖到別人的列會同時改指派），也支援鍵盤拖曳與 `Ctrl+Z` 復原；規則見 `docs/design/gantt-overview.md` §A7。
- **即時同步**：多人同時編輯時以 SSE（`/api/events`）即時更新，斷線自動重連並退回輪詢。
- **問題回饋**：回饋清單，集中收集成員回報的問題。
- **個人頁**：我的任務、釘選項目；可選日期區間產生「匯報報告」（完成的任務與待辦），複製成文字 / Markdown / 表格或下載 .md / .txt / .csv，方便向上級匯報（口徑見 `docs/design/personal.md` §10）。
- **工程追蹤**：手動記錄問題與 worktree 狀態；可選擇讓各人電腦自動回報 worktree（見「工程追蹤的使用方式」）。
- **成員管理**：管理者以上新增成員（臨時密碼、首次登入強制改密碼）、停用 / 啟用、重設密碼、調整角色、解除登入鎖定。
- **個人設定**：每位使用者可在「使用者選單 → 個人設定」自行修改顯示名稱、帳號（需輸入目前密碼）與密碼（成功後其他裝置登出）；規格見 `docs/design/settings.md`。
- **角色與權限**：三層 `root`（超級管理員）> `manager`（管理者）> `user`（成員）；成員管理、狀態 / 專案設定、GitHub 連動、JSON 匯出與合併匯入需 manager 以上，完整 .db 備份下載、匯入「取代全部」與指派 root 僅限 root；以上為預設，root 可在「權限設定」頁調整管理者與成員的權限。完整對照表見 [docs/permissions.md](docs/permissions.md)。
- **安全**：Argon2 密碼雜湊、session 絕對期限與閒置逾時、登入失敗鎖定、CSRF（Origin 檢查 + SameSite cookie）。

技術：後端 Python 3.11+（FastAPI、uvicorn、標準庫 `sqlite3`，WAL 模式）；前端是原生 JavaScript（ES modules）＋ Preact 10（隨附在 `web/static/vendor/preact/`，唯一的第三方前端套件），瀏覽器直接載入，沒有建置步驟。架構見 [docs/frontend.md](docs/frontend.md)。

## 需求

| 項目     | 版本 / 說明                                                                    |
| -------- | ------------------------------------------------------------------------------ |
| Python   | **3.11 以上**（唯一的執行環境：後端、前端、管理指令、測試都是它）              |
| 瀏覽器   | 近兩年內的 Chrome / Edge / Firefox / Safari（需支援 ES modules 與 import map） |
| 作業系統 | Linux（正式環境建議 Debian / Ubuntu）、Windows（實驗室 152 即為 Windows）；macOS 可開發 |
| 反向代理 | 多人使用時建議：Caddy v2（`deploy/linux/Caddyfile`）或 nginx（`deploy/windows/nginx-easytasks.conf`），負責 HTTPS |

Python 相依套件見 `requirements.txt`（實際清單在 `server/requirements.txt`；皆有預編譯 wheel，不需編譯工具）。測試另需 `requirements-dev.txt`。**不需要 Node.js。**

## 本機開發

```bash
python scripts/install.py --dev               # 另裝測試用套件（pytest-playwright、playwright）
.venv/bin/python -m playwright install chromium   # E2E 用的瀏覽器（只要一次）
.venv/bin/python main.py --reload             # 開發模式：改 server/ 自動重載
```

開啟 <http://localhost:3000>。後端啟動時會自動建立資料庫、套用 migration 並寫入預設資料；若沒有任何帳號，會建立預設管理員 `admin` / `password`（見「預設管理員與首次改密碼」）。

- **改前端**：直接改 `web/static/js/`、`web/static/css/` 底下的檔案，瀏覽器**重新整理**就生效（開發模式每次載入頁面都重算靜態檔版本）。沒有建置、沒有 watch。正式模式（`--prod`）版本號在啟動時算一次，改了要重啟。
- **改後端**：`--reload` 會自動重載；沒加就重啟 `main.py`。

常用指令：

| 指令                                                     | 說明                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `python main.py [--reload] [--prod] [--port N]`          | 啟動（後端與前端同一個行程）                               |
| `python -m pytest server -q`                             | 後端測試（含前端模組連結檢查，見「測試」）                 |
| `python -m pytest tests/e2e -q`                          | E2E（瀏覽器實測，見「測試」）                              |
| `python -m server.cli user-add <帳號> [--role root\|manager\|user] [--password 密碼]` | 從命令列新增帳號（預設 `user`；`--admin` 為舊寫法，等同 `--role root`；未給密碼則隨機產生並顯示一次；首次登入須改密碼） |
| `python -m server.cli backup`                            | 備份資料庫（見「備份與還原」）                             |
| `python scripts/install.py --check`                      | 只檢查安裝狀態，不安裝                                     |

> `python` 指 `.venv` 內的 Python：Linux / macOS 為 `.venv/bin/python`，Windows 為 `.venv\Scripts\python.exe`（或先啟用 venv）。所有指令都在專案根目錄執行，會讀取該目錄的 `.env`。

## 環境變數

全部寫在專案根目錄的 `.env`（範本：`.env.example`），程式從**工作目錄**讀取。已存在的系統環境變數優先；空值視同未設定。定義見 `server/app/config.py`。

| 變數                       | 預設            | 說明                                                                                                |
| -------------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `APP_ENV`                  | `development`   | `development` / `production` / `test`。正式環境設 `production`（或啟動加 `--prod`）：cookie 預設加 `Secure`、靜態檔版本只在啟動時算一次。舊名 `NODE_ENV` 仍可用，兩者都有時 `APP_ENV` 優先 |
| `HOST`                     | `127.0.0.1`     | 監聽位址，預設只有本機能連。要讓區網其他電腦直接連才改 `0.0.0.0`；搭配反向代理時維持 `127.0.0.1` |
| `PORT`                     | `3000`          | 後端連接埠                                                                                          |
| `APP_ORIGIN`               | （空）          | 對外網址，例如 `https://tasks.lab.example`。設定後修改類請求只接受此 Origin；未設定則與 `Host` 比對 |
| `DATABASE_PATH`            | `data/app.db`   | SQLite 檔路徑（相對於工作目錄）                                                                     |
| `BASE_PATH`                | （空）          | 掛在反向代理子路徑底下時的網址前綴，例如 `/easytasks`；空 = 網站根目錄。前端的 `index.html` 每次請求時代入，**改了只要重啟** |
| `TZ`                       | `Asia/Taipei`   | 時區                                                                                                |
| `SESSION_MAX_HOURS`        | `9`             | 登入絕對期限（小時，不續期）                                                                        |
| `SESSION_IDLE_MINUTES`     | `60`            | 閒置自動登出（分鐘）                                                                                |
| `COOKIE_SECURE`            | 正式環境 `true` | cookie `Secure` 旗標。只有在**沒有 HTTPS** 的臨時測試才設 `false`                                   |
| `LOGIN_WINDOW_MINUTES`     | `15`            | 登入失敗計數視窗                                                                                    |
| `LOGIN_MAX_FAILS_PER_USER` | `5`             | 同帳號失敗幾次後鎖定                                                                                |
| `LOGIN_LOCK_MINUTES`       | `15`            | 帳號鎖定時間                                                                                        |
| `LOGIN_MAX_FAILS_PER_IP`   | `20`            | 同 IP 失敗幾次後暫拒                                                                                |
| `TRUSTED_PROXY`            | `false`         | 經 Caddy/nginx 反向代理時**必須設 `true`**（取 `X-Forwarded-For` 最右段）；直連 uvicorn 維持 `false`（忽略該標頭，避免偽造） |
| `ADMIN_USERNAME`           | `admin`         | 首次啟動（尚無帳號時）建立的預設管理員帳號；可選覆寫，首次登入強制重設帳號與密碼                    |
| `ADMIN_PASSWORD`           | `password`      | 預設管理員的初始密碼；可選覆寫（留空即 `password`）                                                 |
| `CHANGES_RETENTION_DAYS`   | `30`            | 變更流水保留天數（啟動時與每日修剪；須 > 0）                                                                      |
| `AUDIT_RETENTION_DAYS`     | `365`           | 稽核紀錄保留天數（啟動時與每日自動修剪，見「稽核紀錄與還原」）                                      |
| `PRESENCE_ONLINE_SECONDS`  | `45`            | 在線感知：最後一次回報在幾秒內算「在線」                                                            |
| `PRESENCE_IDLE_SECONDS`    | `300`           | 在線感知：幾秒內算「閒置」，超過即「離線」                                                          |
| `WORKTREE_REPORT_TOKEN`    | （空）          | 各人電腦回報 worktree 用的 token；空白 = 停用回報端點（一律 403）                                   |
| `WORKTREE_SCAN_ROOTS`      | （空）          | 網頁「掃描本機專案」允許的資料夾（逗號分隔）；空白 = 停用，見「工程追蹤的使用方式」               |
| `WORKTREE_STALE_DAYS`      | `2`             | 電腦超過幾天沒回報，工作樹頁面標示「未回報」（只是提示，不刪資料）                                  |
| `GIT_TIMEOUT_MS`           | `10000`         | 伺服器端 git 指令（掃描本機專案、`scan-worktrees`）與回報腳本 `scripts/report_worktrees.py` 的逾時毫秒數 |
| `SYNC_AUTO_RESOLVE_MINUTES` | `10`           | sync-push：兩邊更新時間差距超過幾分鐘才自動採較新者，否則列為待確認衝突（見「多台電腦同步」）      |
| `GITHUB_TOKEN` / `GITHUB_API_URL` / `GITHUB_SYNC_MINUTES` | （空）/ `https://api.github.com` / `5` | 選配 GitHub 連動，見「選配：GitHub 連動」；token 空白 = 停用 |
| `BACKUP_DIR`               | `backups`       | 備份目錄（`python -m server.cli backup` 使用；建議放在不同磁碟）                                    |
| `BACKUP_KEEP`              | `14`            | 保留最近幾份備份                                                                                    |
| `DATA_IMPORT_MAX_MB`       | `50`            | 「資料管理」匯入檔大小上限（MB）                                                                    |
| `ATTACHMENTS_DIR`          | `data/attachments` | 問題附件的存放目錄（見「附件與連結預覽」）                                                        |
| `ATTACHMENT_MAX_MB`        | `25`            | 附件單檔上限（MB）                                                                                  |
| `ATTACHMENT_VIDEO_MAX_MB`  | `200`           | 影片附件單檔上限（MB）；反向代理的請求大小上限也要放寬                                             |
| `ATTACHMENT_MAX_PER_ITEM`  | `10`            | 每筆問題最多幾個附件                                                                                |
| `LINK_PREVIEW_ENABLED`     | `true`          | 問題連結的網頁 metadata 預覽；`false` = 不連網                                                      |
| `LINK_PREVIEW_ALLOW_PRIVATE` | `false`       | 允許預覽抓取內網 / 本機位址（**SSRF 風險**，只建議測試用）                                          |

> 2.0 起不再使用 `WEB_PORT`（以前給 Vite 開發伺服器）與 `STATIC_DIR`（前端固定在 `web/`）；舊 `.env` 留著不會壞，啟動時會提示可以移除。

## 從零部署（Linux + systemd + Caddy）

以下以 Debian / Ubuntu、安裝到 `/opt/tasks-sheets`、主機名稱 `tasks.lab.example` 為例。服務僅供實驗室內網或 VPN 存取。

> Windows server（例如實驗室 152，nginx 子路徑 + NSSM 服務）請改看 [docs/DEPLOY-152.md](docs/DEPLOY-152.md)：`deploy/windows/setup_easytasks.bat` 一次做完安裝與服務註冊。

### 1. 安裝 Python 與 Caddy

```bash
sudo apt-get install -y python3 python3-venv git     # 確認 python3 --version >= 3.11
# Caddy（官方套件庫，指令見 https://caddyserver.com/docs/install#debian-ubuntu-raspbian）
sudo apt-get install -y caddy
```

不需要 Node.js。

### 2. 取得程式、安裝

```bash
sudo useradd --system --home /opt/tasks-sheets --shell /usr/sbin/nologin tasks-sheets
sudo git clone <repo-url> /opt/tasks-sheets
sudo chown -R tasks-sheets:tasks-sheets /opt/tasks-sheets
cd /opt/tasks-sheets
sudo -u tasks-sheets python3 scripts/install.py     # 建 .venv、裝套件、建 data/ logs/ backups/、複製 .env
```

前端是 `web/` 底下的靜態檔，跟著 git 來，不必建置。

### 3. 設定 `.env`

```bash
sudo -u tasks-sheets chmod 600 .env
sudo -u tasks-sheets nano .env
```

正式環境至少修改：

```ini
APP_ENV=production
HOST=127.0.0.1
PORT=3000
APP_ORIGIN=https://tasks.lab.example
# 經 Caddy/nginx 反向代理時必須為 true（否則所有人共用 127.0.0.1 這個登入失敗 IP 桶）
TRUSTED_PROXY=true
DATABASE_PATH=data/app.db
# 留空即預設 admin / password（見「預設管理員」）；首次登入一定會被要求重設帳號與密碼
ADMIN_USERNAME=admin
ADMIN_PASSWORD=
BACKUP_DIR=backups
BACKUP_KEEP=14
# 掛在子路徑（例如 https://host/easytasks/）時才設；改了只要重啟
BASE_PATH=
```

`COOKIE_SECURE` 留空即可（正式環境自動為 `true`）。`.env` 已列入 `.gitignore`，不可提交。

### 4. 手動啟動確認

```bash
sudo -u tasks-sheets .venv/bin/python main.py --prod   # 依 .env 的 HOST / PORT 啟動；Ctrl+C 結束
curl http://127.0.0.1:3000/api/health                  # 另開終端機：{"ok":true,"version":"2.0.0",...}
```

啟動時會自動建立資料庫並套用尚未執行的 migration，不需另外初始化。

### 5. 以 systemd 常駐

```bash
sudo cp deploy/linux/tasks-sheets.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tasks-sheets
sudo systemctl status tasks-sheets
curl http://127.0.0.1:3000/api/health
```

`deploy/linux/tasks-sheets.service` 重點：

- `ExecStart=/opt/tasks-sheets/.venv/bin/python -m uvicorn server.app.main:app --host 127.0.0.1 --port ${PORT} --no-proxy-headers --timeout-graceful-shutdown 3`：一律只綁 `127.0.0.1`；`--timeout-graceful-shutdown` 讓 SSE 長連線不會卡住重啟。
- **只能單一 worker**（不要加 `--workers`）：即時同步的事件中樞與 SQLite 連線在同一個行程內。
- `Environment=APP_ENV=production`、`EnvironmentFile=/opt/tasks-sheets/.env`；注意 `EnvironmentFile` 會覆寫 unit 內的 `Environment=`，所以 `.env` 也必須設 `APP_ENV=production`（舊 `.env` 寫的是 `NODE_ENV=production` 也有效）。
- `ProtectSystem=strict`，只允許寫入 `data/` 與 `backups/`，兩個目錄必須事先存在，否則服務無法啟動。安裝路徑不同時請修改 unit 檔內所有 `/opt/tasks-sheets`。

### 6. 反向代理與 HTTPS（Caddy）

```bash
sudo cp deploy/linux/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile             # 改主機名稱、選擇憑證方式
sudo systemctl reload caddy
```

`deploy/linux/Caddyfile` 重點：

- **憑證**：內網無公開 DNS 時用 `tls internal`（Caddy 內建 CA），再把根憑證 `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` 發給成員安裝信任；有校方憑證則改用 `tls <crt> <key>`；可從網際網路解析的主機刪掉 `tls` 行即自動申請 Let's Encrypt。
- **SSE（`/api/events`）**：`flush_interval -1` 關閉緩衝、`read_timeout 0` / `write_timeout 0` 不設逾時、不套用壓縮；`stream_close_delay 5m` 讓重新載入設定時既有連線不會同時斷線。若改用其他反向代理，請務必做等效設定（見「常見問題」）。
- 其他路徑全部轉給同一個 uvicorn 行程（API + 前端 `web/` 靜態檔 + SPA 路由回退）。靜態檔網址帶版本段（`/static/v/<版本>/...`），回一年快取；`index.html` 一律 no-cache，所以更新程式後重新整理就拿到新版。

開啟 `https://tasks.lab.example` 確認可看到登入頁。

### 7. 每日備份

```bash
sudo cp deploy/linux/tasks-sheets-backup.service deploy/linux/tasks-sheets-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tasks-sheets-backup.timer
sudo systemctl start tasks-sheets-backup    # 立即跑一次確認
journalctl -u tasks-sheets-backup -n 20
ls -l /opt/tasks-sheets/backups
```

每天 03:00 執行 `python -m server.cli backup`，保留 `BACKUP_KEEP` 份。建議再用 rsync / 校內 NAS 把 `backups/` 同步到另一台機器。

### （可選）Docker Compose

`deploy/linux/Dockerfile` 只有一個階段：`python:3.11-slim` 裝 `server/requirements.txt`，再 `COPY server`、`COPY web`、`COPY main.py`，以 `python -m server.app` 執行（單一 worker）。沒有 Node 建置階段。

```bash
cp .env.example .env                        # 依上面步驟 3 修改（路徑類設定會被 compose 覆寫）
SITE_ADDRESS=tasks.lab.example docker compose -f deploy/linux/docker-compose.yml up -d --build
docker compose -f deploy/linux/docker-compose.yml logs app | grep '初始密碼'
docker compose -f deploy/linux/docker-compose.yml exec app python -m server.cli backup   # 備份
```

資料在 volume `tasks-data`，備份在 `tasks-backups`；`tls internal` 的根憑證在 caddy 容器的 `/data/caddy/pki/authorities/local/root.crt`。還原方式見 `deploy/linux/docker-compose.yml` 開頭註解。

## 預設管理員與首次改密碼

- 資料庫中**還沒有任何帳號**時，第一次啟動會建立預設管理員（角色 `root`，超級管理員）：帳號 **`admin`**、密碼 **`password`**（可用 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 覆寫，留空即用預設值）。主控台會印出一行提示。
- 以預設管理員第一次登入時，會進入「請設定新帳號與新密碼」頁面，必須**同時設定新帳號與新密碼**才能繼續：
  - 新帳號不可再是 `admin`（或覆寫的 `ADMIN_USERNAME`），須為 3–32 個英文字母、數字或 `. _ -`，且不可與他人重複。
  - 新密碼至少 8 個字元，不可與目前密碼相同，也不可使用 `password`。
  - 完成後原帳號 `admin` 就不存在了，之後請用新帳號登入；其他裝置上的登入會被登出。
- 其他成員由管理者以上在「成員管理」頁新增（給臨時密碼，對方首次登入只需改密碼；只有超級管理員能指派超級管理員），或在主機上用指令建立帳號：

  ```bash
  cd /opt/tasks-sheets
  # 指定初始密碼（至少 8 字元）
  sudo -u tasks-sheets .venv/bin/python -m server.cli user-add <帳號> --name 顯示名稱 --password 初始密碼
  # 不給密碼：產生隨機密碼並只顯示這一次
  sudo -u tasks-sheets .venv/bin/python -m server.cli user-add <帳號> --name 顯示名稱
  ```

  預設建立 `user`（成員），以 `--role root|manager|user` 指定角色（`--admin` 為舊寫法，等同 `--role root`，會印出提示）。兩種情況對方首次登入都必須立刻改密碼；帳號已存在時會顯示錯誤並以非零 exit code 結束。完整說明見 `python -m server.cli user-add --help`。

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

在暫存目錄以正式模式實際跑過一次（當時是 1.x：前端要先用 npm 建置、環境變數叫 `NODE_ENV`；2.0 起直接 `python main.py --prod`，備份 / 還原流程不變）：

1. 建置前端（1.x 才需要）；以 `NODE_ENV=production`、`HOST=127.0.0.1`、`DATABASE_PATH=<暫存>/data/app.db` 啟動 `python -m server.app`。
2. 確認 `/` 回傳前端 `index.html`、`/some/deep/link` 回退到同一頁（SPA）。
3. 以管理員登入，透過 API 新增 3 個專案（連同預設專案共 4 個），記錄 `GET /api/projects` 結果。
4. **服務運行中**執行 `python -m server.cli backup --out <暫存>/backups --keep 7`，產生 `app-20261125-025344.db`。
5. 備份後再新增 1 個專案（共 5 個）——這筆應在還原後消失。
6. 停止服務（強制結束行程，WAL 檔仍在）；`restore` 未加 `--yes` 時拒絕執行（exit 1）；加 `--yes` 後還原成功，舊檔保留為 `app.db.before-restore-20261125-025344`。
7. 重新啟動、登入，`GET /api/projects` 與步驟 3 的結果**完全相同**（4 個，備份後新增的那筆不在）。

另外 `python -m server.cli backup --self-test` 會在暫存目錄模擬「連線開著、資料仍在 WAL 中」的運行狀態，驗證備份內容一致、保留份數清除、還原後資料一致且可繼續寫入、損毀備份檔會被拒絕；`server/tests/test_backup.py` 以真實 schema 涵蓋相同情境與 CLI 行為。

## 資料匯出與匯入

管理者以上在側邊導覽「資料管理」（`/admin/data`）可以（其中「下載完整備份」與「取代全部資料」僅超級管理員可見可用）：

- **下載 JSON 匯出檔**：全部業務資料（任務含軟刪除、專案、狀態、自訂欄位、問題回饋、個人清單、工程問題、worktree 紀錄、GitHub 連動設定、成員基本資料），**不含**密碼雜湊、登入 session、登入紀錄與變更流水。關聯以穩定識別碼 uid（成員以帳號）表示，可匯入另一套系統。
- **下載完整備份（.db）**：資料庫原樣快照（`VACUUM INTO`）。**含密碼雜湊與 session，屬敏感檔**，下載前會再確認；還原仍用上節的 `python -m server.cli restore <檔> --yes`。
- **匯入**：選擇 JSON 匯出檔 → 預覽（不改資料）各類別「新增 / 相同（略過）/ 衝突」與缺少成員 → 選擇處理方式 → 套用。
  - 衝突 = 兩邊都有同一筆（同 uid；狀態與專案也會以相同名稱對應）但內容不同。全域策略：**以較新者為準**（預設，比較 updatedAt，同時間保留本機）/ 保留本機 / 使用匯入檔，並可逐筆覆寫。
  - 缺少成員（匯入檔的帳號在本系統不存在）：略過指派（欄位留空；該成員的個人清單略過）或自動建立（一般成員、隨機臨時密碼只在結果畫面顯示一次、首次登入須改密碼）。
  - 套用前自動備份到 `BACKUP_DIR`（`<資料庫名>-pre-import-<時間>.db`），整個套用在單一 transaction，任何錯誤全數回滾。
  - **取代全部資料**：先刪除本機全部業務資料（成員保留）再匯入，需輸入確認字樣「取代全部資料」。
  - 匯入檔上限 `DATA_IMPORT_MAX_MB`（預設 50 MB）；較新版本系統匯出的檔案（schemaVersion 較大）會被拒絕。

不開網頁也能用指令搬資料（與網頁同一份邏輯 `server/app/data_transfer.py`）：

```bash
.venv/bin/python -m server.cli export export.json [--db data/app.db]
.venv/bin/python -m server.cli import export.json --dry-run                 # 只預覽
.venv/bin/python -m server.cli import export.json [--strategy keep_newer|keep_local|use_import] \
    [--create-missing-users] [--replace --yes] [--out backups]
```

細節見 `docs/design/data-export.md`。

## 多台電腦同步

各台電腦上的本機系統可以把資料增量上傳到中央伺服器（單向：本機 → 中央）。

1. 管理者在中央「資料同步 → 同步來源」為每台電腦建立來源，取得**只顯示一次**的金鑰。
2. 在那台電腦的專案目錄執行（可排入工作排程定期執行；中斷後直接重跑即可）：

   ```bash
   python -m server.cli sync-push --server https://中央網址 --token tss_xxx [--db data/app.db] [--dry-run] [--full]
   ```

3. 只會新增與更新，**資料不見不會被當成刪除**；兩邊都改過時，更新時間差超過 `SYNC_AUTO_RESOLVE_MINUTES`（預設 10 分鐘）自動採較新者，否則列入「待確認衝突」由管理者逐欄位決定。

需要 HTTPS；附件檔案本體不同步。權限 `sync.manage` / `sync.resolve`（預設管理者以上）。完整說明見 `docs/sync.md`。

## 權限設定

超級管理員在側邊導覽「權限設定」（`/admin/permissions`）可以調整「管理者」「成員」各自能做哪些操作：勾選後按底部的「儲存」即生效，在線成員不需重新整理，畫面入口會即時出現 / 消失；「還原為預設」可一鍵回到系統預設。

- 超級管理員永遠擁有全部權限，不能被調整（避免把自己鎖在外面）。
- 受保護項目（指派超級管理員、完整備份下載、匯入取代全部、權限設定本身）只限超級管理員，無法授予其他角色。
- 邊界由你決定：例如授予成員「管理成員」等於允許成員把自己升為管理者；取消某角色的「編輯任務」後，該角色仍可瀏覽但不能修改。

預設矩陣、受保護項目與限制見 [docs/permissions.md](docs/permissions.md)。

## 稽核紀錄與還原

所有重要改動（任務、專案、狀態、自訂欄位、成員、權限設定、匯入 / 同步摘要）都會留下「誰、何時、改了什麼（前後內容）」的紀錄，用來**回溯原因與還原失誤，而非評比個人**。

- 管理者以上在側邊導覽「稽核紀錄」（`/admin/audit`）可依時間、操作者、類型、動作篩選，展開看「修改前 / 修改後」（長描述有行內差異），按「還原」一鍵改回。若那個欄位之後又被別人改過，會先提示目前的內容，確認後才「仍要還原（覆蓋）」。
- 所有成員可在任務詳情最下方的「活動歷史」看到這個任務的修改紀錄（沒有還原按鈕）。
- 個人待辦不記錄；密碼內容一律不記錄。紀錄保留 `AUDIT_RETENTION_DAYS`（預設 365）天。

可還原 / 不可還原的規則與資料模型見 [docs/design/audit-log.md](docs/design/audit-log.md)。

## 任務討論區與描述鎖定

- 任務詳情抽屜最下方是**討論區**：大家可以在這裡和負責人、管理者溝通，或留下自己的筆記。每則訊息都能「回覆」形成討論串（只有一層回覆，回覆預設收合），討論結束可「標記為已解決」。輸入 `@` 可提及成員；`Enter` 送出、`Shift+Enter` 換行，沒送出的草稿會保留。
- 討論區高度固定、在自己的區域內捲動，訊息再多也不會把抽屜撐長；需要專心討論時按右上角「展開」佔滿抽屜（`Esc` 還原）。
- 清單與看板的任務標題旁會顯示討論數，有未讀（含被提及）時多一個藍色小圓點；打開任務後即視為已讀。
- **描述鎖定**：任務派發後，管理者可按描述旁的鎖頭鎖定描述，避免被誤改；鎖定後成員看到提示「有補充或筆記，歡迎寫在下方討論區」，管理者仍可修改。
- 權限：`comments.write`（留言，預設全員）、`comments.moderate`（刪除他人訊息，預設管理者）、`tasks.lock`（鎖定描述，預設管理者），可在「權限設定」調整。
- 留言會隨 JSON 匯出 / 匯入，但**不會**透過多台電腦同步（sync-push）傳送。規格見 [docs/design/task-discussion.md](docs/design/task-discussion.md)。

## 多人同時使用與在線感知

- 多人可同時編輯同一個專案：寫入以欄位為單位（兩人改同一任務的不同欄位都會保留，同一欄位後寫者勝），變更透過 SSE 在 2 秒內推送給所有人。
- 頂欄右側的「雲朵」頭像堆疊顯示誰在線上（綠點）或暫時離開（黃點）；滑過頭像可看到對方正在看的頁面或任務，點雲朵可看全部成員與「最後上線」。任務抽屜、清單列與看板卡片也會顯示「誰也在看 / 正在編輯」。
- 不想讓別人看到自己在看什麼：在線面板底部勾「隱藏我的動態」（存在瀏覽器，別人只會看到你在線上）。
- 在線回報**不會延長登入**：閒置逾時仍只看點擊、鍵盤等實際操作。
- 門檻可用 `PRESENCE_ONLINE_SECONDS`（預設 45）與 `PRESENCE_IDLE_SECONDS`（預設 300）調整。
- 架構、限制、建議規模與併發測試結果見 `docs/multi-user.md`；介面規格見 `docs/design/presence.md`。

## 升級流程

先看 [CHANGELOG.md](CHANGELOG.md) 這一版「資料格式有沒有變」「要不要先備份」。

```bash
cd /opt/tasks-sheets
sudo -u tasks-sheets .venv/bin/python -m server.cli backup             # 1. 先備份（或 systemctl start tasks-sheets-backup）
sudo -u tasks-sheets git pull --ff-only                                # 2. 取得新版
sudo -u tasks-sheets .venv/bin/pip install -r requirements.txt         # 3. 更新 Python 套件（前端跟著 git 來，不必建置）
sudo systemctl restart tasks-sheets                                    # 4. 重啟（啟動時自動套用新 migration）
sudo journalctl -u tasks-sheets -n 50                                  # 5. 確認無錯誤；curl /api/health 看 version
```

Windows（152）用 `deploy\windows\update_easytasks.bat`，順序相同（備份 → git pull → pip → 重啟 → 健康檢查）。

若新版啟動失敗：`git checkout <舊版 tag/commit>` → 重新 `pip install -r requirements.txt` → 依「還原步驟」還原升級前的備份（新版 migration 可能已改動資料庫結構）。

### 從 1.x（React + Vite 版）升級到 2.0

- **資料不用搬**：`data/app.db` 原檔直接沿用，資料格式沒有變，migration 在啟動時自動套用。照慣例先 `python -m server.cli backup`。
- **不再需要 Node.js**：照上面的流程 `git pull` → `pip install` → 重啟即可，不必 `npm ci`、`npm run build`。
- `.env`：`NODE_ENV` 改名 `APP_ENV`（舊名仍可用、`APP_ENV` 優先）；`WEB_PORT`、`STATIC_DIR` 不再使用，可刪。`BASE_PATH` 改了只要重啟。
- 啟動方式：`python main.py`（`python -m server.app` 與 systemd 的 uvicorn 指令仍可用）。
- 舊版殘留的 `dist/`、`node_modules/`、`.tools/`（Windows 自動下載的 Node）已經用不到，可以手動刪除。
- 各人電腦的 worktree 回報改用 `python scripts/report_worktrees.py`（參數相同，見下節）。

## 工程追蹤的使用方式

- **手動輸入為主**：「工程追蹤」頁的問題與 worktree 紀錄由成員直接新增 / 編輯 / 結案，狀態一律手動維護。伺服器端只有在啟用「掃描本機專案」時才會對允許的資料夾執行唯讀 git 指令。
- **狀態可自訂**：問題與工作樹的狀態選單底部有「＋ 新增狀態…」「管理狀態…」（改名、改色、類別、排序、封存）。內建新增了 卡住 / 延後 / 不處理（問題）與 損毀 / 技術債 / 舊版保留 / 未知（工作樹）。權限 `eng.status.manage` 預設全員可用，root 可在「權限設定」調整。
- **工作樹每人一份**：「工作樹」分頁右上的「檢視」可切換我自己 / 其他成員（唯讀）/ 全部成員（網址 `?user=`），第一層依負責人、第二層依電腦；新增、貼上、掃描登記時負責人預設為目前登入者。
- **掃描本機專案**：在 `.env` 設定 `WORKTREE_SCAN_ROOTS`（允許掃描的資料夾，逗號分隔，例如 `C:\work,D:\repos`）並重啟後，管理者可在工作樹分頁按「掃描本機專案」→ 預覽（新增 / 已存在 / 可能搬動）→ 勾選登記。未設定時此功能停用。也可在自己的電腦用指令一次登記：

  ```bash
  python -m server.cli scan-worktrees <專案資料夾> [--machine 電腦名稱] [--repo 專案名稱] [--dry-run] [--yes]
  ```

- **貼上登記（最簡單）**：在專案資料夾執行 `git worktree list`（PowerShell 可 `git worktree list | Set-Clipboard`，也支援 `--porcelain`），到工作樹分頁按「貼上 git worktree list」把輸出整段貼上 → 預覽（新增 / 已存在 / 可能搬動；`.claude/worktrees`、scratchpad、Temp 等疑似暫時性者預設不勾）→ 登記。不執行 git、不需資料夾路徑或 `WORKTREE_SCAN_ROOTS`，一般成員即可使用；重複貼同一份不會重複登記。
- **不見不等於刪除**：每台電腦以識別碼（`~/.tasks-sheets/machine.json`，第一次回報時自動建立，可編輯其中的 `machineName`）區分，改名或同名不混淆。回報中不見的 worktree 只會標示「回報中找不到」，紀錄一律保留；空清單或筆數驟減的回報會先攔下（保留舊資料），要有人在頁面按「確認採用這次回報」才套用。路徑不同但分支與 HEAD 相同時提示「可能是搬動」並可一鍵更新路徑。刪除紀錄改為「移到回收區」，隨時可還原；只有管理者按「清空回收區」才會永久刪除。
- **各人電腦自動回報（選用）**：在 `.env` 設定 `WORKTREE_REPORT_TOKEN`（夠長的隨機字串，例如 `python -c "import secrets; print(secrets.token_urlsafe(32))"`）並重啟服務；各人在自己的電腦（需 Python 3.9+ 與 git）執行：

  ```bash
  WORKTREE_REPORT_TOKEN=<同一個 token> python scripts/report_worktrees.py --server https://tasks.lab.example --path <repo 路徑>
  # PowerShell：$env:WORKTREE_REPORT_TOKEN='<token>'; python scripts/report_worktrees.py --server https://tasks.lab.example
  # 其他參數：--machine <電腦名稱>、--repo <repo 名稱>；先看會送出什麼：加 --dry-run
  ```

  腳本會把本機 `git worktree list` 的快照（dirty / ahead / behind / 是否已併入 main）連同電腦識別碼送到 `POST /api/eng/worktrees/report`，頁面上會與手動紀錄比對並提示「可能遺失 / 回報中找不到 / 可能搬動 / 未登記」，僅供參考（回報被攔下時腳本會印出提醒）。腳本只依賴 Python 標準函式庫，可單獨複製到其他電腦（不必裝本專案的套件）；可用排程（cron / 工作排程器）定期執行。`GIT_TIMEOUT_MS` 環境變數可調整腳本內 git 指令逾時（預設 10000）。參數與 `~/.tasks-sheets/machine.json` 的格式都與 1.x 的 `node scripts/report-worktrees.mjs` 相同，換指令即可。
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

### 附件與連結預覽

**附件**：問題列點 ▸ 展開後有附件區，可拖放檔案、點選選擇、或直接在說明欄 / 附件區 Ctrl+V 貼上截圖；新增問題時也可先附檔，建立後自動上傳。

- 支援：圖片（png / jpg / gif / webp）、影片（mp4 / webm / mov，可直接播放、拖曳進度條）、音訊（mp3 / wav / m4a）、pdf、文字（txt / md / csv / json / log）、zip、Office 文件。SVG 與其他類型不接受。伺服器會以檔案內容驗證類型（改副檔名無效）。
- 上限：一般檔案 `ATTACHMENT_MAX_MB`（預設 25 MB）、影片 `ATTACHMENT_VIDEO_MAX_MB`（預設 200 MB）、每筆問題 `ATTACHMENT_MAX_PER_ITEM`（預設 10 個）。
- 檔案存在 `ATTACHMENTS_DIR`（預設 `data/attachments`，檔名為隨機 id）。systemd 部署時 `ReadWritePaths` 已包含 `data/`；Docker 映像預設 `/data/attachments`（同一個 volume）。
- **反向代理要放寬上傳大小與逾時**：Caddy 見 `deploy/linux/Caddyfile` 的附件上傳區塊（`request_body { max_size 210MB }`、讀寫逾時 10 分鐘）；nginx：

  ```nginx
  location ~ ^/api/eng/issues/[0-9]+/attachments$ {
      client_max_body_size 210m;      # 大於 ATTACHMENT_VIDEO_MAX_MB
      proxy_request_buffering off;    # 直接串流給後端
      proxy_read_timeout 600s;
      proxy_send_timeout 600s;
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $remote_addr;
  }
  ```

- **備份**：`python -m server.cli backup` 會把附件檔一併備份到 `backups/<備份檔>.attachments/`（同磁碟用硬連結，不額外佔空間），`restore` 同步還原；`--no-attachments` 只備份資料庫。**JSON 匯出（資料管理）只含附件清單，不含檔案本體，附件檔案請用完整備份帶走。** 匯入「取代模式」後若留下沒有對應問題的檔案，可用 `python -m server.cli attachments-prune` 清除。

**連結預覽**：問題的「連結」存檔後，伺服器會在背景抓取該網頁的標題、說明、縮圖（og:image）、favicon、網站名稱與前 300 字摘要，在展開列顯示預覽卡片；可按「重新取得預覽」。**目前提供 metadata 預覽，不含整頁截圖**（整頁截圖需要伺服器端無頭瀏覽器）。GitHub issue 連結沿用 GitHub 同步，不另抓預覽。

- 安全：只抓 http / https；拒絕本機與內網位址（含 `169.254.169.254` 雲端 metadata、各種 IP 寫法與 IPv6），每次重新導向都重新檢查，連線時固定使用驗證過的 IP；逾時 10 秒、最多讀 1 MB、不帶 cookie、不執行 JavaScript。
- `LINK_PREVIEW_ENABLED=false` 可完全停用（不連網）；`LINK_PREVIEW_ALLOW_PRIVATE=true` 允許抓內網位址，**有 SSRF 風險，預設關閉**，只建議用於測試或完全隔離的內網。

## 任務依賴與延遲鏈

- 在任務詳情的「依賴」加入**前置任務**（要先完成的事）或**完成後可開始的任務**；可在「進階」設定前置完成後再等幾天。會形成循環的依賴會被拒絕並列出環上的任務。
- 前置任務完成（狀態類別為「已完成」）或被刪除後就不再擋人。
- 看板上等待中的卡片以琥珀色標示，並顯示「等待中 · 預計延後 N 天 → 日期」；右上可關閉「顯示依賴標示」。
- 「延遲鏈」分頁（任務檢視中甘特圖後面，`/tasks/delay-link`）由左到右顯示整條「誰在等誰」的鏈，強調決定最終完成日的路徑，並標出目前可立即開始的任務。
- 用意是讓大家看見依賴、提早安排或互相支援，不是追究責任。推算公式與限制見 [docs/design/delay-link.md](docs/design/delay-link.md)（sync-push 尚不同步依賴；JSON 匯出入有包含）。

## 常見問題

**Q：登入後馬上又被登出 / 一直回到登入頁？**
正式模式 cookie 帶 `Secure`，必須經由 HTTPS 存取。直接用 `http://主機:3000` 測試時才把 `COOKIE_SECURE=false`。

**Q：存檔時出現 403「來源不被允許」？**
`APP_ORIGIN` 必須與瀏覽器網址列的來源完全相同（含 `https://`、不含結尾 `/`、非預設連接埠要寫出來）。不確定時可先留空。

**Q：忘記管理員密碼？**
由管理者或超級管理員在成員管理頁重設（超級管理員的密碼只有其他超級管理員能重設）；若沒有其他超級管理員，在主機上 `.venv/bin/python -m server.cli user-add <新帳號> --role root` 建立新的超級管理員再處理。

**Q：首次啟動後要用什麼登入？**
帳號 `admin`、密碼 `password`（若 `.env` 有覆寫 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 則以其為準）。登入後須立即重設帳號與密碼。

**Q：即時更新延遲、或每隔一段時間斷線？**
通常是反向代理緩衝或逾時。Caddy 請用 `deploy/linux/Caddyfile` 的 `/api/events` 設定；nginx 需對該路徑設定：

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
確認 `ExecStart` 有 `--timeout-graceful-shutdown`（或使用 `python main.py` / `python -m server.app`，已內建 3 秒）；否則 uvicorn 會等所有 SSE 連線結束。

**Q：為什麼後端只綁 `127.0.0.1`？**
登入失敗的 IP 限制在 `TRUSTED_PROXY=true` 時採用 `X-Forwarded-For` 最右段（由代理附加、用戶端無法偽造）；只讓 Caddy 連入可確保該標頭一定經過代理，也避免繞過 HTTPS。沒有反向代理時請維持 `TRUSTED_PROXY=false`，後端改用連線的 socket 位址並忽略該標頭。

**Q：可以開多個 uvicorn worker 嗎？**
不行。即時同步的事件中樞在行程記憶體內，多 worker 會讓部分使用者收不到更新。實驗室規模單一行程即足夠。

**Q：資料庫檔旁邊的 `app.db-wal`、`app.db-shm` 是什麼？可以刪嗎？**
WAL 模式的暫存檔，**服務運行中絕對不可刪除或單獨複製 `app.db`**（會遺失或損毀資料）。備份請一律用 `python -m server.cli backup`。

**Q：備份放哪裡比較好？**
`BACKUP_DIR` 指向另一顆磁碟或掛載的 NAS，並定期把備份複製到另一台機器。記得兩個 systemd unit 的 `ReadWritePaths` 也要加上該路徑。

**Q：改了 JS / CSS 沒有生效？**
開發模式重新整理即可；正式模式（`--prod`、systemd、Windows 服務）的靜態檔版本在啟動時算一次，要重啟服務。瀏覽器若還是舊的，按 `Ctrl+Shift+R` 強制重新載入。

**Q：畫面一片空白？**
打開瀏覽器開發者工具的 Console。常見原因是瀏覽器太舊（不支援 import map）或反向代理把 `/static/` 底下的 `.js` 回成錯的 MIME。`/static/` 底下找不到的檔一律回 404（不會回 `index.html`），錯誤訊息會直接指出是哪個檔。

## 測試

先 `python scripts/install.py --dev`、`.venv/bin/python -m playwright install chromium`（Windows 把 `.venv/bin/python` 換成 `.venv\Scripts\python`）。

```bash
.venv/bin/python -m pytest server -q       # 後端測試（API、資料庫、備份、部署腳本、前端模組連結檢查）
.venv/bin/python -m pytest tests/e2e -q    # E2E：真的開瀏覽器操作
```

- **前端模組連結檢查**（`server/tests/test_web_modules.py`）：掃過 `web/static/js/` 每個檔，確認每個 `import` 都指到存在的檔、每個被 import 的名字對方真的有 export。這取代了以前 TypeScript 的型別檢查能抓到的那一類錯誤（打錯檔名、改名沒改完）。
- **E2E**（Python 版 Playwright，`tests/e2e/`）：`conftest.py` 起一個正式模式的伺服器在埠 3999（可用 `E2E_PORT` 換），用獨立的 `data/e2e.db`；固定測試帳號定義在 `server/e2e_setup.py`（`E2E_USERS` 是單一來源），共用操作在 `tests/e2e/helpers.py`；`test_smoke.py` 會載入每一個前端模組確認沒有執行期錯誤。
- 沒有 vitest、eslint、prettier、tsc：前端沒有建置也沒有型別檢查，靠上面三道防線（詳見 [docs/frontend.md](docs/frontend.md)）。

## 專案結構

```
main.py                    唯一的啟動入口（python main.py）
requirements.txt           執行用套件（→ server/requirements.txt）；requirements-dev.txt 測試用
.env.example               設定範本（install.py 會複製成 .env）
CHANGELOG.md               每版的變更與資料格式說明
server/
  app/                     後端：main.py 組裝應用、app.py 掛路由與靜態檔、features/ 每個功能一個檔、version.py 版本
  migrations/              資料表 SQL（啟動時自動套用）
  cli.py                   管理指令（python -m server.cli --help）
  e2e_setup.py             E2E 測試帳號（單一來源）
  tests/                   後端 pytest（含 test_web_modules.py 前端連結檢查）
web/
  index.html               頁面模板（伺服器代入 {{BASE}}、{{STATIC}}）
  static/js/               前端原生 ES modules：features/ 各頁、lib/ 共用、shell/ 外框、ui/ 元件、shared/ 資料形狀
  static/css/              樣式（base / tokens / components / features/…）
  static/vendor/preact/    唯一的第三方：Preact 10（MIT）
tests/e2e/                 Python 版 Playwright E2E（conftest.py、helpers.py、test_*.py）
scripts/
  install.py               第一次安裝 / 檢查
  report_worktrees.py      各人電腦回報 worktree（工程追蹤）
deploy/
  linux/                   systemd、Caddy、Docker
  windows/                 152 用的 setup / update / 服務註冊 / 備份批次檔、nginx 範例
docs/                      交接、部署、設計文件（入口：docs/HANDOFF.md）
data/  backups/  logs/     執行期資料（不進版控）
```

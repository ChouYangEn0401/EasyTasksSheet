# 把本機資料搬到 server

本文教你把「在自己電腦上跑的 TasksSheets 資料」搬到自架 server。每個指令都標示驗證狀態：

- **【已實測】**：2026-11-25 在 Windows 11 / Python 3.11 以兩個獨立資料夾（模擬本機與 server）實際跑過，輸出與文件一致。
- **【未實測】**：Linux 專用或需要外部工具（scp、systemd、Caddy、Docker），本次環境沒有，依 `deploy/` 範本與程式碼撰寫，第一次執行請多留意輸出。

## 目錄

- [1. 先選搬法](#1-先選搬法)
- [2. 搬法 A：整包搬（建議）](#2-搬法-a整包搬建議)
- [3. 搬法 B：JSON 匯出再匯入](#3-搬法-bjson-匯出再匯入)
- [4. 搬法 C：持續 sync-push](#4-搬法-c持續-sync-push)
- [5. 常見問題](#5-常見問題)
- [6. 還原失敗時如何回復](#6-還原失敗時如何回復)

## 1. 先選搬法

| 搬法                 | 帶走什麼                                                          | 適合情境                                    | 不適合                                |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ------------------------------------- |
| **A 整包搬**         | 全部：資料表、**密碼雜湊與 session**、權限設定、附件檔案          | 「本機就是要變成正式」，server 上還沒資料   | server 上已有別人在用的資料           |
| **B JSON 匯出→匯入** | 業務資料（任務、專案、回饋、個人清單、工程問題…）；不含密碼與附件 | server 上已有資料，要把本機資料**合併**進去 | 需要附件、帳號密碼原樣保留            |
| **C sync-push**      | 同 B（增量、單向、可重複）；不含密碼與附件                        | 多台電腦長期各自記錄，定期匯總到中央        | 一次性搬家（用 A 較簡單）             |

決策流程：server 還是空的 → **A**；server 已有資料要合併 → **B**；之後還要持續從多台電腦匯入 → **C**（可與 A 或 B 搭配：先 A/B 搬一次，再用 C 持續）。

**附件檔案只有 A 會帶走。** B、C 不會建立附件（連附件紀錄都沒有），我們實測匯入後 `attachments` 表為 0 筆。

## 2. 搬法 A：整包搬（建議）

流程總覽：本機停止服務 → 備份（資料庫 + 附件）→ 傳到 server → server 安裝程式 → 設定 `.env` → `restore` → 啟動 → 驗證。

### 2.0 搬之前確認

- 本機登入過、**已完成「首次登入重設帳號與密碼」**。若本機資料庫還是預設的 `admin` / `password`，搬到 server 後任何人都能登入，請先在本機重設，或搬完立刻登入重設再開放連線。
- 程式版本：server 的程式碼要與本機**相同或更新**（`git log -1` 比對）。較舊的程式不認得新 migration；較新的會在啟動時自動升級資料庫（見 [5. 常見問題](#5-常見問題)）。

### 2.1 本機：停止服務並備份

先停止本機的 `python main.py`（終端機按 Ctrl+C）。備份其實在服務運行中也能執行，但搬家請先停止，避免備份後又有人寫入。

在專案根目錄執行（Windows PowerShell；`.venv` 內的 Python）【已實測】：

```powershell
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe -m server.cli backup
```

輸出（路徑視你的 `.env` 而定）：

```text
[backup] ...\data\app.db → ...\backups\app-20261125-124633.db
[backup] 附件 ...\data\attachments → ...\backups\app-20261125-124633.db.attachments
```

產生兩樣東西，**搬家時兩個都要帶**：

| 項目                         | 說明                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `app-<日期>-<時間>.db`       | 資料庫快照（單一檔案，不依賴 `-wal` / `-shm`）                                          |
| `app-<日期>-<時間>.db.attachments` | 附件資料夾（檔名為 32 位隨機 id，只含資料庫有紀錄的附件）                         |

備份位置預設是專案根目錄的 `backups/`，可用 `--out <資料夾>` 或 `.env` 的 `BACKUP_DIR` 改。若輸出出現「警告：資料庫有紀錄但找不到附件檔」，代表那個附件檔本機已遺失，搬過去也找不到。

**替代做法：網頁下載**（root 才有；「資料管理 → 下載完整備份」）：只會得到 `.db` 檔，**不含附件**。附件請自己把本機 `data\attachments` 資料夾複製一份，改名為 `<下載的檔名>.attachments`（例如 `tasks-sheets-backup-20261125-124633.db.attachments`）放在 `.db` 旁邊，restore 時就會一起還原。用網頁下載的 `.db` 單獨還原時，指令會提示「此備份沒有附件資料夾，附件目錄維持不變」【已實測】。建議直接用 CLI。

### 2.2 傳輸到 server

三選一，目標是把 `.db` 與 `.db.attachments` 資料夾放到 server 上某個資料夾（以下用 `/tmp/incoming`）。

```powershell
# (1) scp：Windows 10/11 內建 OpenSSH【未實測】
scp -r backups\app-20261125-124633.db backups\app-20261125-124633.db.attachments you@server:/tmp/incoming/

# (2) 同一網路的共用資料夾 / 外接硬碟：robocopy 複製整個備份資料夾【已實測，本機到本機】
robocopy backups E:\transfer /E

# (3) 壓成一個檔再傳（檔案多時較穩）【未實測】
Compress-Archive -Path backups\app-20261125-124633.db, backups\app-20261125-124633.db.attachments -DestinationPath move.zip
scp move.zip you@server:/tmp/
# server 上：unzip /tmp/move.zip -d /tmp/incoming
```

備份檔含**密碼雜湊與登入 session**，屬敏感檔：只走你信任的通道，搬完把傳輸用的副本刪掉。

### 2.3 server：安裝程式

以 Debian / Ubuntu、安裝到 `/opt/tasks-sheets` 為例（完整說明見 README「從零部署」）【未實測，Linux 指令】：

```bash
sudo apt-get install -y python3 python3-venv git      # python3 --version 要 >= 3.11
sudo useradd --system --home /opt/tasks-sheets --shell /usr/sbin/nologin tasks-sheets
sudo git clone <repo-url> /opt/tasks-sheets
cd /opt/tasks-sheets
sudo mkdir -p data backups
sudo chown -R tasks-sheets:tasks-sheets /opt/tasks-sheets

sudo -u tasks-sheets python3 -m venv .venv
sudo -u tasks-sheets .venv/bin/pip install -r requirements.txt
```

前端頁面二選一：

- server 上建置：安裝 Node.js 22 後 `sudo -u tasks-sheets npm ci && sudo -u tasks-sheets npm run build`（產生 `dist/web`）。
- 不想在 server 裝 Node：在本機 `npm run build`，把整個 `dist/web` 資料夾複製到 server 的 `/opt/tasks-sheets/dist/web`。

Windows server 也可以：`python -m venv .venv`、`.venv\Scripts\activate`、`pip install -r requirements.txt`（已實測可安裝並啟動）。

### 2.4 server：設定 `.env`

```bash
sudo -u tasks-sheets cp .env.example .env
sudo -u tasks-sheets chmod 600 .env
sudo -u tasks-sheets nano .env
```

搬家會用到的設定（完整列表見 README「環境變數」）：

```ini
NODE_ENV=production          # systemd 部署務必設，--prod 啟動時可省略
HOST=127.0.0.1               # 有反向代理就維持這個；只做區網測試才改 0.0.0.0
PORT=3000
APP_ORIGIN=https://tasks.lab.example   # 對外網址，與瀏覽器網址列完全相同；還不確定就先留空
TRUSTED_PROXY=true           # 有 Caddy / nginx 時必須 true；直連 uvicorn 維持 false
COOKIE_SECURE=               # 留空：production 自動為 true（需要 HTTPS）
DATABASE_PATH=data/app.db    # restore 的目標
ATTACHMENTS_DIR=data/attachments   # 附件還原到這裡
BACKUP_DIR=backups           # 之後每日備份的位置
```

重點：

- 路徑是**相對於「執行指令的資料夾」**（專案根目錄）。`restore` 與服務都必須在同一個資料夾執行，才會指到同一份資料。不放心就寫絕對路徑。
- `.env` 只在工作目錄讀取；**系統環境變數優先於 `.env`**。若 restore 後資料不對，先檢查是否有殘留的 `DATABASE_PATH` 環境變數。【已實測：在 server 資料夾放 `.env`，restore 與啟動都依其路徑】

### 2.5 server：還原

確認服務沒有在跑（第一次安裝尚未啟動則略過）：`sudo systemctl stop tasks-sheets`。

備份要讓 `tasks-sheets` 帳號讀得到：

```bash
sudo chmod -R a+rX /tmp/incoming
```

在專案根目錄還原（**一定要加 `--yes`**，沒加會拒絕並結束 exit 1）：

```bash
cd /opt/tasks-sheets
sudo -u tasks-sheets .venv/bin/python -m server.cli restore /tmp/incoming/app-20261125-124633.db --yes
```

Windows 等價指令【已實測】：

```powershell
.\.venv\Scripts\python.exe -m server.cli restore E:\transfer\app-20261125-124633.db --yes
```

預期輸出：

```text
[restore] 已用 ...\app-20261125-124633.db 還原 ...\data\app.db
[restore] 已還原附件目錄 ...\data\attachments
```

- `restore` 找到 `<備份檔>.attachments` 資料夾就會自動還原附件到 `ATTACHMENTS_DIR`，**不需要另外複製附件**。
- 若 server 上原本已有 `data/app.db`，會先保留為 `app.db.before-restore-<時間>`（附件目錄同樣保留為 `attachments.before-restore-<時間>`），見[第 6 節](#6-還原失敗時如何回復)。
- 還原前會驗證備份檔完整性，損毀則中止、不動現有資料。

### 2.6 server：啟動

先手動啟動確認（Ctrl+C 結束）：

```bash
cd /opt/tasks-sheets
sudo -u tasks-sheets .venv/bin/python main.py --prod      # 【未實測，Linux】--prod 的 cookie 要 HTTPS，見下
curl http://127.0.0.1:3000/api/health                      # {"ok":true,...}
```

Windows 上 `python main.py`（不加 `--prod`，http）啟動、`/api/health` 與登入皆正常【已實測】。

**http 還是 https，決定要不要 `--prod`：**

| 情境                                | 啟動方式               | 原因                                                         |
| ----------------------------------- | ---------------------- | ------------------------------------------------------------ |
| 前面有 Caddy 等 HTTPS 反向代理      | `--prod`（或 systemd） | cookie 帶 `Secure`，只有 HTTPS 才送得出去                    |
| 純 http 的區網測試（`HOST=0.0.0.0`） | **不加 `--prod`**      | 加了會「登入成功但下一個請求就 401」，看起來像一直被登出     |

加 `--prod` 又走 http 的後果我們實測過：登入回 200，但接著的 `/api/auth/me` 回 401【已實測】。

正式常駐用 systemd（單一 worker，不要加 `--workers`）【未實測】：

```bash
sudo cp deploy/tasks-sheets.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tasks-sheets
sudo systemctl status tasks-sheets
```

安裝路徑不是 `/opt/tasks-sheets` 時，要改 unit 檔內所有路徑；`data/`、`backups/` 必須事先存在，否則服務起不來。

### 2.7 server：Caddy 反向代理與 HTTPS

【未實測，無 Caddy 環境】

```bash
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # 改主機名稱；內網無公開 DNS 保留 tls internal
sudo systemctl reload caddy
```

`tls internal` 會用 Caddy 內建 CA，需把根憑證 `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` 發給使用者安裝信任。`.env` 同步確認：`TRUSTED_PROXY=true`、`APP_ORIGIN=https://你的網址`、`HOST=127.0.0.1`。

### 2.8 驗證清單

用瀏覽器開 `https://tasks.lab.example`（或測試用的 `http://<server>:3000`）逐項勾：

- [ ] **登入**：用**本機的帳號密碼**登入（不是 `admin/password`；舊帳號原樣保留）。我們實測：搬過去後 `admin/password` 登入回 401，原帳號登入成功。
- [ ] **資料筆數**：總覽、任務清單、問題回饋、個人清單、工程追蹤的筆數與本機一致（搬家前先記下數字，或用本機「資料管理」的匯出統計對照）。
- [ ] **附件**：工程追蹤打開有附件的問題，圖片能顯示、影片能播放、檔案能下載。我們實測：附件下載內容的 SHA-256 與本機一致。
- [ ] **成員**：「成員管理」帳號都在；還沒改過初始密碼的帳號，首次登入仍會被要求改密碼。
- [ ] **即時與在線**：兩個瀏覽器分別登入，一邊改任務，另一邊約 1 秒內更新；頂欄雲朵顯示對方在線（若不即時，多半是反向代理緩衝，見 README「常見問題」）。
- [ ] **權限設定**：root 的「權限設定」頁自訂內容（若本機有調整）仍在。
- [ ] **改管理員密碼**：搬家用過的帳號、傳輸過程接觸過備份的人，建議在「個人設定」換密碼；其他裝置會被登出。
- [ ] **備份**：在 server 執行 `python -m server.cli backup` 能產生備份；設好每日備份（README「每日備份」）。
- [ ] **清理**：確認一切正常後，刪除 `/tmp/incoming`、`move.zip` 與本機傳輸副本（含密碼雜湊）。本機舊服務不要再開，以免兩邊資料分岔。

## 3. 搬法 B：JSON 匯出再匯入

適合 server 上**已經有資料**，要把本機的資料合併進去。匯出檔不含密碼雜湊與 session，也**沒有附件**。規格見 [design/data-export.md](design/data-export.md)。

### 3.1 本機匯出

網頁：管理者以上 →「資料管理 → 下載 JSON 匯出檔」。或指令【已實測】：

```powershell
New-Item -ItemType Directory -Force export | Out-Null     # export 指令不會自動建立資料夾
.\.venv\Scripts\python.exe -m server.cli export export\export.json
```

```text
[export] 已匯出到 export\export.json（成員 2、狀態 4、專案 2、自訂欄位 0、任務 3、問題回饋 1、個人清單 1、工程問題 1、Worktree 紀錄 0、GitHub 連動 0）
```

把 `export.json` 傳到 server（`scp`、USB 皆可；檔案上限預設 50 MB，由 `DATA_IMPORT_MAX_MB` 控制）。

### 3.2 server 先預覽，再匯入

先 `--dry-run` 看「新增 / 相同 / 衝突」與缺少的成員，不會寫入任何東西【已實測】：

```bash
cd /opt/tasks-sheets
sudo -u tasks-sheets .venv/bin/python -m server.cli import /tmp/export.json --dry-run
```

```text
[import] 預覽（新增 / 相同 / 衝突）：
  任務：3 / 0 / 0
  ...
  缺少成員：alice
[import] --dry-run：未寫入任何資料
```

確認後正式匯入（寫入前會自動備份到 `BACKUP_DIR`，檔名 `<資料庫名>-pre-import-<時間>.db`，整個匯入在單一 transaction，失敗全數回滾）：

```bash
sudo -u tasks-sheets .venv/bin/python -m server.cli import /tmp/export.json \
    [--strategy keep_newer|keep_local|use_import] [--create-missing-users]
```

網頁同樣可做：「資料管理 → 匯入」選檔 → 預覽 → 選處理方式 → 套用（管理者以上）。

### 3.3 兩個要決定的事

**缺少成員**（匯出檔裡的帳號在 server 不存在）：

| 做法                              | 結果                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 預設：略過指派                    | 負責人等欄位留空；該成員的**個人清單被略過**（個人清單必須有擁有者）                                             |
| `--create-missing-users`          | 自動建立一般成員，隨機臨時密碼**只在輸出顯示一次**、首次登入須改密碼【已實測，印出「已建立成員 alice，臨時密碼…」】 |

想完整保留個人清單：先在 server「成員管理」建好同帳號的成員，再匯入。

**衝突**（同一筆兩邊都有且內容不同；以 uid 對應，狀態與專案以「名稱相同」對應）：

| `--strategy`           | 結果                                                |
| ---------------------- | --------------------------------------------------- |
| `keep_newer`（預設）   | 比較 `updatedAt`，匯入檔較新才採用；同時間保留 server |
| `keep_local`           | 一律保留 server 的內容                              |
| `use_import`           | 一律採用匯入檔                                      |

我們實測：server 上改了任務標題（更新時間較新），預覽顯示「衝突 任務「任務一」：標題（較新：local）」；`keep_newer` 之下 server 標題被保留，`use_import` 才被覆蓋【已實測】。網頁版可以**逐筆覆寫**策略。

重複匯入同一個檔是安全的：相同資料不會變動。

## 4. 搬法 C：持續 sync-push

每台電腦保有自己完整的 TasksSheets，定期把變動單向上傳到中央。完整設計見 [sync.md](sync.md)。重點：

- 資料以 uid 對應，**只新增與更新，缺少的資料絕不刪除**；兩邊都改過且更新時間差 ≤ `SYNC_AUTO_RESOLVE_MINUTES`（預設 10 分鐘）會列為「待確認衝突」，由管理者在「資料同步」頁決定。
- 不上傳密碼、session、權限設定、**附件檔案**。

步驟：

1. 中央（server）管理者：「資料管理 → 資料同步 → 同步來源 → 新增同步來源」，為每台電腦各建一個，複製**只顯示一次**的金鑰（`tss_...`）。
2. 該電腦在專案根目錄【已實測，對 `http://127.0.0.1` 的測試 server】：

   ```powershell
   # 先看會上傳什麼（不連線寫入）
   .\.venv\Scripts\python.exe -m server.cli sync-push --server https://tasks.lab.example --token tss_xxx --dry-run
   # 正式上傳
   .\.venv\Scripts\python.exe -m server.cli sync-push --server https://tasks.lab.example --token tss_xxx
   ```

   實測輸出：第一次「全量」13 筆，`新增 1、更新 0、相同 12、衝突 0`；再跑一次只剩增量 1 筆、全部相同。中央每天第一次上傳前會自動備份（`<db>-pre-sync-<來源>-<時間>.db`）。

3. 排程：Windows 工作排程器 / Linux cron 定期執行。金鑰可放環境變數 `SYNC_TOKEN`，避免留在命令歷史。
4. 水位存在本機 `data/.sync-state.json`；刪掉它等於下次全量上傳（冪等，安全）。

注意：

- **正式網址必須 HTTPS**（只有 `localhost` / `127.0.0.1` 例外）；對外 http 會被拒絕。
- 沒有的成員預設略過指派；來源可開「自動建立缺少的成員」。
- 附件檔案要另外搬（搬法 A，或手動複製）。
- 本機時鐘要準（建議開網路校時），衝突判斷依各電腦的更新時間。

## 5. 常見問題

**版本不一致 / migration**
啟動與所有 CLI 指令都會**自動套用尚未執行的 migration**。把舊版資料庫搬到較新的程式上沒問題，會自動升級（建議搬之前保留一份備份）。反過來——用**較舊**的程式開**較新**版本的資料庫——程式沒有防呆也不保證可用（新欄位 / 新表它不認得），請先把 server 的程式更新到相同或更新的版本。JSON 匯出檔的 `schemaVersion` 比 server 新時會被拒絕，請先更新 server。目前最新 migration 是 `server/migrations/0012_*.sql`。

**還原後 session 與密碼**
整包搬（A）會帶走密碼雜湊與 session：帳號密碼原樣可用；備份當下仍有效的 session 在還原後也會有效（受 9 小時絕對期限與 60 分鐘閒置限制），不想保留的話請在 server 啟動後讓大家重新登入或改密碼。B、C 不帶密碼，新建立的成員都是隨機臨時密碼，由管理者在「成員管理」重設。

**`HOST` / `COOKIE_SECURE` / `--prod`**
- `HOST=127.0.0.1`（預設）：只有 server 本機連得上，搭配反向代理用。`0.0.0.0` 是「監聽所有網卡」，瀏覽器**不能**開 `http://0.0.0.0:3000`，要開 `http://<server IP>:3000`。
- `--prod`（或 `NODE_ENV=production`）使 cookie 帶 `Secure`，必須 HTTPS。http 測試請不加 `--prod`，或在 `.env` 設 `COOKIE_SECURE=false`（僅限無 HTTPS 的臨時測試）。
- 前端已建置在 `dist/web` 時，不論模式都由後端提供頁面。

**Windows cp950（繁中 Windows）**
先設 `$env:PYTHONUTF8='1'`，避免 Python 以 cp950 讀寫中文輸出而出錯。`requirements.txt` 必須維持純 ASCII，否則 `pip install` 在 cp950 下會失敗。

**時間與時區**
`TZ` 預設 `Asia/Taipei`。資料庫存的是 UTC 毫秒時間戳，換 server 不會讓時間錯位；顯示的「今天」「本週」依 server 的 `TZ`。Windows 沒有 tzdata 套件時，程式對 `Asia/Taipei` 改用固定 +8 位移（`_overview_compute.py`），台灣時區結果相同。備份檔名的時間是**本地時間**。

**Linux 權限與擁有者**
`data/`、`backups/`、`.env` 要歸服務帳號（如 `tasks-sheets`）所有；用 root `sudo` 直接跑 `restore` 會讓還原出的 `app.db` 變成 root 擁有，服務就無法寫入（`attempt to write a readonly database`）。請一律 `sudo -u tasks-sheets ...` 執行，或事後 `sudo chown -R tasks-sheets:tasks-sheets /opt/tasks-sheets/data`。systemd 的 `ProtectSystem=strict` 只允許寫 `data/` 與 `backups/`，附件目錄與備份目錄若放在別處，要加進 unit 的 `ReadWritePaths`。【未實測】

**資料庫旁的 `app.db-wal`、`app.db-shm`**
WAL 暫存檔，服務運行中不要刪、**不要單獨複製 `app.db`**。搬資料一律用 `backup`。

**附件找不到 / 圖片裂開**
確認 `ATTACHMENTS_DIR` 指向還原後的附件資料夾，且服務帳號可讀寫。附件檔名是隨機 id，與資料庫紀錄一一對應，不能只搬其中一邊。

**反向代理上傳附件失敗**
影片上限 200 MB，Caddy 要放寬 `request_body max_size`（`deploy/Caddyfile` 已設）；nginx 要設 `client_max_body_size 210m`。

**Docker 部署**
`deploy/docker-compose.yml` 檔頭有備份與還原指令（`docker compose ... run --rm app python -m server.cli restore /backups/<檔> --yes`）。備份檔要先放進 volume `tasks-backups`。【未實測，本機無 Docker】

## 6. 還原失敗時如何回復

`restore` 在覆蓋前**一定會保留舊資料**：

| 項目       | 保留的名稱                                         |
| ---------- | -------------------------------------------------- |
| 資料庫     | `data/app.db.before-restore-<時間>`                |
| 附件資料夾 | `data/attachments.before-restore-<時間>`           |

回復方法（先停止服務）：

```bash
cd /opt/tasks-sheets/data
rm -f app.db-wal app.db-shm
mv app.db app.db.bad
mv app.db.before-restore-20261125-124755 app.db
# 若附件也要回復：
mv attachments attachments.bad && mv attachments.before-restore-20261125-124755 attachments
```

確認新資料沒問題後，才刪除 `*.before-restore-*`。

其他保險：

- 還原用的備份檔本身不會被修改，可重複執行 `restore`。
- 備份檔損毀會被拒絕，並且**不動現有資料庫**。
- 匯入（B）寫入前自動備份在 `BACKUP_DIR` 的 `*-pre-import-*.db`，要回復就停止服務後用 `restore` 還原那一份。
- 本機原資料在確認 server 沒問題之前請**不要刪除**；本機的 `backups/` 也先保留。

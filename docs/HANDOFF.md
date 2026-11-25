# 交接總覽

TasksSheets 是給實驗室內部用的多人任務 / 專案管理網站。本文是接手時的第一份讀物：現況、程式地圖、如何跑、如何擴充、已知問題與待決策。**要把本機資料搬到 server，請直接看 [MOVE-TO-SERVER.md](MOVE-TO-SERVER.md)。**

## 目錄

- [1. 專案現況與功能清單](#1-專案現況與功能清單)
- [2. 技術架構與目錄地圖](#2-技術架構與目錄地圖)
- [3. 如何啟動](#3-如何啟動)
- [4. 環境變數重點](#4-環境變數重點)
- [5. 帳號與權限](#5-帳號與權限)
- [6. 資料與備份概念](#6-資料與備份概念)
- [7. 多人使用與限制](#7-多人使用與限制)
- [8. 同步、匯入匯出：何時用哪個](#8-同步匯入匯出何時用哪個)
- [9. 安全注意事項](#9-安全注意事項)
- [10. 測試如何跑](#10-測試如何跑)
- [11. 已知問題與限制](#11-已知問題與限制)
- [12. 待使用者決策](#12-待使用者決策)
- [13. 如何擴充](#13-如何擴充)
- [14. 開發流程紀錄](#14-開發流程紀錄)
- [15. 文件索引](#15-文件索引)

## 1. 專案現況與功能清單

功能全部完成並合併到 `main`，等使用者驗收。後端為 Python（FastAPI + uvicorn + SQLite），前端為 React + Vite。2026-11-25 交接時實測：pytest 479 通過、vitest 227 通過（見[第 10 節](#10-測試如何跑)）。

| 頁面（路由）                          | 功能                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 總覽 `/`                              | 每位成員的進行中任務卡、近三週完成 / 處理件數；語氣中性、不排名（[product-principles.md](product-principles.md)）   |
| 任務 `/tasks/list` `kanban` `gantt`   | 清單（就地編輯、快速新增、自訂欄位、詳情抽屜）、看板（拖曳改狀態與排序）、甘特圖；可直接管理狀態與專案；抽屜內可建立相關任務（`task_relations`，0013）與複製任務（`features/task_relations.py`，規格見 [design/task-list.md §13](design/task-list.md)） |
| 任務 `/tasks/list` `kanban` `gantt`   | 清單（就地編輯、快速新增、自訂欄位、詳情抽屜含待辦清單 checklist（`task_checklist_items` 0014，列表 / 看板顯示 ☑ 3/5 徽章，[design/task-list.md §16](design/task-list.md)）、拖曳列換群組 / 排序）、看板（拖曳改狀態與排序）、甘特圖；可直接管理狀態與專案。詳情抽屜下方有討論區（討論串、@提及、未讀徽章）與描述鎖定（[task-discussion.md](design/task-discussion.md)） |
| 延遲鏈 `/tasks/delay-link`          | 任務依賴（前置任務 → 等待中的任務，禁止循環）、看板琥珀色「等待中 · 預計延後 N 天」、整條依賴鏈與最長延遲路徑（[design/delay-link.md](design/delay-link.md)） |
| 問題回饋 `/feedback`                  | 回饋 / 問題清單與月曆排程（拖曳排程）                                                                                |
| 個人清單 `/me`                        | 我的任務、釘選、自由待辦（含延後 / 取消等小狀態）；「產生匯報報告」依日期區間彙整完成事項（`personal_report.py`、`personal_items.done_at` 0020，規格見 [design/personal.md §10](design/personal.md)） |
| 個人設定 `/settings`                  | 改顯示名稱、帳號、密碼（改密碼後其他裝置登出）                                                                       |
| 工程追蹤 `/eng`                       | 問題（含附件圖片 / 影片 / 檔案、連結預覽、選配 GitHub 連動）、工作樹（worktree）紀錄、自訂狀態、掃描本機專案、貼上 `git worktree list` 快速登記、回收區 |
| 成員管理 `/admin/users`               | 新增 / 停用 / 重設密碼 / 角色 / 解鎖（`members.manage`）                                                             |
| 資料管理 `/admin/data`                | JSON 匯出 / 匯入（預覽、衝突策略）、完整 .db 備份下載（root）                                                        |
| 資料同步 `/admin/data/sync`           | 多台電腦 sync-push 的來源金鑰與待確認衝突                                                                            |
| 權限設定 `/admin/permissions`         | root 調整管理者 / 成員各項權限，即時生效                                                                             |
| 稽核紀錄 `/admin/audit`               | 重要改動的前後內容與一鍵還原（`audit.view` / `audit.revert`，含衝突保護）；任務詳情底部「活動歷史」（[audit-log.md](design/audit-log.md)） |
| 全站                                  | 即時同步（SSE）、在線感知（頂欄雲朵頭像）、登入逾時與鎖定                                                            |
| 全站復原 / 重做                       | `Ctrl+Z` / `Ctrl+Shift+Z`（頂欄按鈕）：任務編輯 / 拖曳 / 新增 / 刪除、個人待辦、回饋新增；純記憶體（[design/undo.md](design/undo.md)） |

## 2. 技術架構與目錄地圖

單一 Python 行程（uvicorn）同時提供 `/api/*` 與前端靜態檔（`dist/web`），資料在一個 SQLite 檔。Node 只用於建置前端與開發。

```text
main.py                  根目錄入口（python main.py [--prod] [--reload]）
requirements.txt         僅 -r server/requirements.txt（必須純 ASCII）
server/
  cli.py                 管理指令：user-add / backup / restore / export / import / sync-push / scan-worktrees / attachments-prune
  sync_client.py         sync-push 本機端
  e2e_setup.py           E2E 前建立專用 DB 與固定帳號
  migrations/            0000_init.sql ... 0012_*.sql，啟動時自動套用
  app/
    main.py / app.py     組裝 app、掛全部 router、middleware（CSRF、登入、寫入權限守門）
    config.py            唯一的環境變數來源（預設值、驗證）
    db.py                SQLite 連線（單一連線 + RLock）、migration、seed
    permissions.py       capability 預設矩陣、中文名稱、受保護項目、require()
    security.py / pwcheck.py   session、CSRF、登入限制、密碼檢查
    backup.py            備份 / 還原（VACUUM INTO、附件）
    data_transfer.py     JSON 匯出匯入核心（CLI 與網頁共用）
    sync_push.py / sync_hub.py   多電腦同步中央邏輯 / SSE 廣播中心
    presence.py          在線登錄（記憶體）
    attachments.py / link_preview.py / github.py / worktree_scan.py
    features/            每個功能一個檔案（見下表）
src/
  shared/                前端用的 zod schema 與型別（permissions.ts 名稱表須與後端一致）
  web/features/<功能>/   每個頁面一個資料夾（頁面元件、api.ts、model.ts + model.test.ts、css）
  web/shell/             外殼：AppShell、導覽、Header、RequireAuth
  web/lib/               auth、sync（SSE）、permissions（useCan）
deploy/                  Caddyfile、systemd、Dockerfile、docker-compose（皆未實測）
tests/e2e/               Playwright；tests/helpers/e2eUsers.ts 固定帳號
docs/                    規格與說明；docs/design/ 為各頁面介面規格
```

功能對應（後端 `server/app/features/` → 前端 `src/web/features/`）：

| 功能          | 後端                                       | 前端                          |
| ------------- | ------------------------------------------ | ----------------------------- |
| 登入 / 帳號   | `auth.py`、`profile.py`                    | `auth/`、`settings/`          |
| 任務 / 專案 / 狀態 / 自訂欄位 | `tasks.py`、`projects.py`、`properties.py` | `tasks/`、`kanban/`、`gantt/` |
| 總覽          | `overview.py`、`_overview_compute.py`      | `overview/`                   |
| 回饋 / 月曆   | `feedback.py`                              | `feedback/`、`calendar/`      |
| 個人清單      | `personal.py`                              | `personal/`                   |
| 工程追蹤      | `eng.py`、`eng_status.py`、`eng_attach.py`、`eng_paste.py`（+ `worktree_paste.py` 解析器） | `eng/`                        |
| 成員 / 權限   | `admin.py`、`users.py`、`permissions_admin.py` | `admin/`                  |
| 資料匯出入 / 備份下載 | `data_admin.py`                    | `admin/DataPage.tsx`          |
| 多電腦同步    | `sync_push.py`、`sync.py`（SSE）           | `admin/SyncPage.tsx`          |
| 在線感知      | `presence.py`                              | `presence/`                   |

資料庫以純 SQL migration 管理（沒有 ORM），參數化查詢。每次寫入同一個 transaction 記一筆 `changes` 流水，SSE hub 每 250 ms 查新流水推給所有連線。

## 3. 如何啟動

**開發**（需要 Node 22.18+ 與 Python 3.11+）：

```powershell
$env:Path += ";C:\Program Files\nodejs"     # PowerShell 找不到 npm 時
$env:PYTHONUTF8 = '1'
npm ci --ignore-scripts                     # 前端相依；--ignore-scripts 避免 Windows 上安裝腳本失敗
npm run py:install                          # 建立 .venv 並安裝後端相依
Copy-Item .env.example .env                 # 可省略，全部有預設值
npm run dev                                 # 後端 :3000（自動重載）+ Vite :5173，開 http://localhost:5173
```

**單機執行（含已建置前端）**：`npm run build` 後 `python main.py`，開 `http://localhost:3000`。預設只綁 `127.0.0.1`。

**正式**：`python main.py --prod`（cookie 要求 HTTPS，需反向代理）或 systemd（`deploy/tasks-sheets.service`）。完整的 Linux + systemd + Caddy 流程見 README「從零部署」；搬資料見 [MOVE-TO-SERVER.md](MOVE-TO-SERVER.md)。純 http 的區網測試**不要**加 `--prod`。

第一次啟動自動建立資料庫、套用 migration、寫入預設狀態與專案；沒有任何帳號時建立 `admin` / `password`。

## 4. 環境變數重點

全部在專案根目錄 `.env`（範本 `.env.example`；定義在 `server/app/config.py`）。系統環境變數優先於 `.env`，空值視同未設定。完整表格見 README「環境變數」，交接時最重要的：

| 變數                                  | 重點                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_ENV`                            | `production` = cookie `Secure`；`--prod` 等同設定它                          |
| `HOST` / `PORT`                       | 預設 `127.0.0.1:3000`；有反向代理就別改 HOST                                 |
| `APP_ORIGIN`                          | 對外網址；設了之後修改類請求只接受此 Origin                                  |
| `TRUSTED_PROXY`                       | 有 Caddy / nginx 時必須 `true`，直連維持 `false`                             |
| `DATABASE_PATH` / `ATTACHMENTS_DIR` / `BACKUP_DIR` | 資料、附件、備份位置（相對於工作目錄）                          |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`   | 首次啟動的預設管理員，預設 `admin` / `password`                              |
| `SESSION_MAX_HOURS` / `SESSION_IDLE_MINUTES` | 登入絕對期限 9 小時、閒置 60 分鐘                                     |
| `WORKTREE_REPORT_TOKEN` / `WORKTREE_SCAN_ROOTS` | 選用：各人電腦回報 worktree、網頁掃描本機專案；空 = 停用           |
| `GITHUB_TOKEN`                        | 選用：GitHub 連動；空 = 完全不連網                                           |
| `LINK_PREVIEW_ALLOW_PRIVATE`          | 維持 `false`（SSRF 風險）                                                    |

## 5. 帳號與權限

- **預設管理員**：資料庫沒有任何帳號時建立 `admin` / `password`（角色 root）。首次登入強制「同時重設帳號與密碼」：新帳號不可再是 `admin`，密碼至少 8 字元且不可是 `password`。
- **其他帳號**：管理者以上在「成員管理」新增（臨時密碼、首次登入須改密碼）；或 `python -m server.cli user-add <帳號> [--role root|manager|user] [--password …]`，預設 `user`。
- **三層角色**：`root`（超級管理員）> `manager`（管理者）> `user`（成員）。root 恆有全部權限且不可被覆寫；至少保留一位啟用中的 root。
- **總覽統計開關**：`users.in_overview`（migration 0019；root 預設 0、其餘 1），成員管理可切換；關閉者不出現在總覽成員卡與近三週統計，任務不受影響（見 design/gantt-overview.md §B）。
- **權限設定頁**：root 可在 `/admin/permissions` 勾選 / 取消 manager 與 user 的每項權限（capability），儲存後即時生效（只存與預設不同的格子，`role_permissions` 表）。
- **受保護權限**（只限 root，無法授予）：`data.backup_db`（完整 .db 下載）、`data.import_replace`（匯入取代全部）、`roles.assign_root`、`permissions.configure`。
- **後端強制、前端只顯示**：所有判斷在後端 `require(capability)` 與寫入守門 middleware；前端以 `useCan()` 顯示 / 隱藏，不以角色字串判斷。CLI 屬伺服器本機操作，不受權限限制。
- 完整矩陣與端點對照：[permissions.md](permissions.md)。

## 6. 資料與備份概念

- **資料庫**：單一 SQLite 檔（預設 `data/app.db`），WAL 模式；旁邊的 `-wal`、`-shm` 是暫存檔，運行中**不可刪除，也不可單獨複製 `app.db`**。必須放本機磁碟，不可放 NFS / SMB。
- **附件**：檔案存在 `ATTACHMENTS_DIR`（預設 `data/attachments`），檔名是 32 位隨機 id，與資料庫 `attachments` 表一一對應。
- **migration**：`server/migrations/*.sql` 依編號在啟動與任何 CLI 指令時自動套用，已套用者記在 `_migrations`；升級程式後不需手動動資料庫。
- **備份**：`python -m server.cli backup`（運行中可執行）以 `VACUUM INTO` 產生一致快照 `backups/app-<時間>.db` 與附件資料夾 `app-<時間>.db.attachments`，並依 `BACKUP_KEEP`（預設 14）清除舊備份。每日備份用 `deploy/tasks-sheets-backup.timer`。
- **還原**：停止服務 → `python -m server.cli restore <備份檔> --yes`；原資料庫保留為 `.before-restore-<時間>`。
- `python -m server.cli backup --self-test` 在暫存目錄演練備份與還原。

## 7. 多人使用與限制

- **單一 worker**：SSE 廣播中心與在線登錄都在行程記憶體，不可開多個 worker 或多台機器分流。
- **併發寫入**：單一連線序列化，欄位層級合併（不同欄位都保留，同欄位後寫者勝）。
- **建議規模**：同時在線 ≤ 30 人、SSE 連線 ≤ 60。實驗室 10–20 人綽綽有餘。
- **閒置計時**：只有非 GET 的寫入與前端的實際操作心跳會刷新；presence 回報與 SSE 不刷新，所以分頁開著不動 60 分鐘仍會登出。
- **反向代理**必須關閉 SSE 緩衝（`deploy/Caddyfile` 已處理），否則即時更新延遲；斷線時前端自動退回 30 秒輪詢。
- 細節與併發測試結果：[multi-user.md](multi-user.md)。

## 8. 同步、匯入匯出：何時用哪個

| 方式                   | 帶什麼                                   | 用在                                         |
| ---------------------- | ---------------------------------------- | -------------------------------------------- |
| 完整 .db 備份 + 附件   | 全部，含密碼雜湊與 session、附件檔案     | 備份、整機搬家（server 還是空的）            |
| JSON 匯出 / 匯入       | 業務資料；不含密碼、session、附件        | 合併進已有資料的系統、有衝突需要預覽與決定   |
| `sync-push`            | 同 JSON，增量、單向（本機 → 中央）       | 多台電腦長期並存，定期匯總                   |

**附件檔案只有完整備份會帶走。** 同步與匯入都不處理附件。選擇建議與實測步驟見 [MOVE-TO-SERVER.md](MOVE-TO-SERVER.md)；設計見 [sync.md](sync.md)、[design/data-export.md](design/data-export.md)。

## 9. 安全注意事項

- **預設密碼 `password` 很弱**，只靠「首次登入強制重設」保護。部署到可被他人連到的環境前，務必自己先登入完成重設。
- **`TRUSTED_PROXY`**：有反向代理必須 `true`（取 `X-Forwarded-For` 最右段，防偽造）；直連 uvicorn 必須 `false`，否則攻擊者可偽造 IP 繞過登入限制。
- **`HOST`**：預設 `127.0.0.1`。設 `0.0.0.0` 會讓區網直連（沒有 HTTPS）；正式環境請放在反向代理後面。
- **cookie / HTTPS**：正式模式 cookie 帶 `Secure`；`COOKIE_SECURE=false` 只限無 HTTPS 的臨時測試。
- **SSRF 防護**：連結預覽只抓 http/https，拒絕本機與內網位址（含雲端 metadata 位址、各種 IP 寫法）、每次轉址重新檢查、不帶 cookie；`LINK_PREVIEW_ALLOW_PRIVATE=true` 會關掉防護，只限測試。不想連網就 `LINK_PREVIEW_ENABLED=false`。
- **附件**：以檔案內容驗證類型（改副檔名無效）、不接受 SVG、有單檔與每筆數量上限；檔名為隨機 id，不使用上傳檔名存檔。
- **敏感檔**：完整 `.db` 備份含密碼雜湊與 session，只走可信通道、用完刪除。`.env` 已 gitignore，勿提交。
- **其他**：Argon2 密碼雜湊、登入失敗鎖定（帳號與 IP 兩層）、CSRF（Origin 檢查 + SameSite）、同步金鑰只存 SHA-256 且只接受 HTTPS。

## 10. 測試如何跑

Windows 一律用 **PowerShell**（Git Bash 跑 vitest 會失敗）：

```powershell
$env:Path += ";C:\Program Files\nodejs"
$env:PYTHONUTF8 = '1'                # 繁中 Windows（cp950）必設，否則中文輸出 / 讀檔出錯
npm ci --ignore-scripts
npm run py:install
npm run check        # lint + typecheck + vitest + pytest + build，一次全跑
npm test             # 只跑 vitest（前端單元）
npm run py:test      # 只跑 pytest（後端）
npm run test:e2e     # Playwright（會 build 並以 E2E 專用 DB 啟動，port 3999）
npm run backup:self-test
npx prettier --check .
```

- 交接時實測：`npm run py:test` 479 通過、`npm test` 227 通過。E2E 與 `npm run check` 交接時未重跑（先前驗收 E2E 28/28）。
- **`requirements.txt` 必須維持純 ASCII**：pip 以系統碼頁讀取，繁中 Windows（cp950）遇到非 ASCII 會安裝失敗（曾因此出過 bug）。
- E2E 帳號（由 `server/e2e_setup.py` 建立，同 `tests/helpers/e2eUsers.ts`）：`admin`（root）、`manager`、`member`（user）、`newbie`（首次登入須改密碼）、`bootstrap`（模擬預設管理員，ADMIN_USERNAME）、`peer`。其他 spec 請勿動 `newbie` 與 `bootstrap`。
- E2E 專用 DB 路徑必須含 `e2e`（`e2e_setup.py` 會拒絕其他路徑，避免誤刪正式資料）。

## 11. 已知問題與限制

出處為 PROGRESS.md 與各 docs，並已對照 2026-11-25 的程式核對（無法在本機驗證的標「未重驗」）。

**部署與環境**

1. Dockerfile、docker-compose、Caddyfile、systemd unit **未實測**（本機無 docker / caddy / Linux）；真實 GitHub API（token 權限、速率限制、分頁）未實測。
2. Git Bash 跑 vitest 會失敗，請用 PowerShell；`npm ci` 要加 `--ignore-scripts`。
3. 僅支援單一 worker；SQLite 不可放網路磁碟；權限覆寫與同步速率限制快取都是單一行程設計。
4. E2E 在 Windows 偶見 `ConnectionResetError [WinError 10054]` 訊息，不影響結果（未重驗）。

**行為**

5. 後端**不強制**「改密碼前不可使用其他 API」，只有前端導向（已核對：`security.py` 無此檢查）。直接打 API 的人用預設密碼就能操作。
6. 預設管理員密碼 `password` 很弱，僅靠首次登入強制重設保護（見[第 9 節](#9-安全注意事項)）。
7. 匯入預覽 token 存在記憶體，服務重啟即失效（重新預覽即可）。
8. 權限：一般協作權限（`tasks.edit` 等）只限制寫入、不隱藏前端控制項，被收回的人操作時才看到「沒有權限」；授予 user `members.manage` 等於可把自己升為 manager；直接用 SQL 改 `role_permissions` 需重啟才生效；權限設定不在 JSON 匯出入 / 同步範圍。
9. 附件不隨 JSON 匯入 / sync-push 同步（紀錄與檔案都不會建立）。任務待辦清單（checklist）隨 JSON 匯出入，但 sync-push 目前不同步。
10. 同步依各電腦時鐘判斷新舊，時鐘誤差大會誤判；同步單向，中央變更不回寫。
11. 在線感知：多分頁以最後回報為準；重啟後即時狀態全部視為離線。
12. 匯入「取代全部」後可能留下沒有對應問題的附件檔，用 `python -m server.cli attachments-prune` 清除。
13. 稽核紀錄（feat/audit-log，[audit-log.md](design/audit-log.md)）：留言、描述鎖定、待辦清單、相關任務、依賴已接入（範圍見 audit-log.md「記錄範圍」）；匯入與同步只記一筆摘要、不可逐筆還原，同步衝突的手動處理不記錄；個人待辦、問題回饋、工程追蹤不記錄；專案與成員的「建立」、狀態「改移並刪除」不可還原；保留 `AUDIT_RETENTION_DAYS`（預設 365）天後自動刪除。即時更新沿用各資料本身的變更流水（不另寫 `audit` 流水）。
14. 任務討論區：留言與已讀位置**不透過 sync-push 同步**（JSON 匯出 / 匯入有帶）；沒有獨立通知系統，@提及只反映在清單 / 看板的未讀徽章；「與我有關」篩選只看已載入的討論串；軟刪除的訊息內容仍留在資料庫與匯出檔；資料管理頁尚未顯示留言的匯入統計（API 回應有 `taskComments`）。描述鎖定只在詳情抽屜切換（快速新增未提供「建立後鎖定」）。見 [design/task-discussion.md](design/task-discussion.md) §9。

**UI 小瑕疵（依 PROGRESS，未重驗）**

15. 部分頁面失敗仍用頁內提示列而非 toast；編輯衝突「採用」鈕未做。
16. 看板 PinButton 一直顯示；768–1023px 回饋頁拖曳時「取消排程」放置列未做（鍵盤可取消）。
17. 甘特圖：長條起點在畫面左側外時，條內標題被切；768 寬時分組標頭同時有逾期 Badge，成員名稱會被截斷。
18. 6 處 Python docstring 仍寫「行為同 src/server/…」（歷史對照，`src/server` 已移除，已核對仍存在）。

**任務依賴（feat/delay-link，[design/delay-link.md](design/delay-link.md)）**

19. 多台電腦同步（sync-push）不同步依賴（JSON 匯出 / 匯入有包含，成環者略過並列出原因）。
20. 甘特圖尚未畫依賴箭頭；只支援 finish-to-start；延後以日曆天推算（不排除週末與假日）。

## 12. 待使用者決策

1. **GitHub issue 自動匯入**：目前只有手動「匯入開啟中的 issue」與貼連結同步，是否要自動排程匯入。
2. **後端強制改密碼**：是否在 server 端於改密碼前封鎖其他 API（目前僅前端導向，見問題 5）。
3. **預設管理員帳密設定方式**：目前是 `admin` / `password`（或 `.env` 覆寫）加首次強制重設；是否改為首次啟動互動設定或隨機密碼。
4. **本機資料如何搬到 server**：整包搬或 JSON 合併（見 [MOVE-TO-SERVER.md](MOVE-TO-SERVER.md)）。
5. **正式環境形態**：Linux + systemd + Caddy 或 Docker；憑證用 `tls internal`、校方憑證或 Let's Encrypt。
6. **備份異地**：`BACKUP_DIR` 放哪裡、是否 rsync 到 NAS。
7. **是否開啟選用功能**：GitHub 連動（`GITHUB_TOKEN`）、各人電腦 worktree 回報（`WORKTREE_REPORT_TOKEN`）、網頁掃描本機專案（`WORKTREE_SCAN_ROOTS`）。

「本週完成」已改為 `completed_at` 精確算法，不再是待決策。

## 13. 如何擴充

新增一個功能的慣例（參考既有功能照抄結構）：

1. **後端 router**：在 `server/app/features/<name>.py` 建 `APIRouter`，於 `server/app/app.py` 以 `app.include_router(<name>.router, prefix="/api/<name>")` 掛上；請求內容用 pydantic 驗證（`schemas.py` 或該檔內），錯誤用 `errors.py` 的 `HttpError`。需登入的路由預設就受 `api_guard` 保護；免登入的要加進 `PUBLIC_PATHS`（慎用）。
2. **寫入要記變更流水**：在 transaction 內呼叫 `record_change(conn, entity_type, id, action, actor, t)`，SSE 才會推給其他使用者；前端 `src/web/lib/sync.ts` 的 `ENTITY_QUERY_KEYS` 依 `entity_type` 重抓對應查詢（新的 entity_type 要在此登記）。
3. **migration 編號**：在 `server/migrations/` 新增下一個編號 `0013_<說明>.sql`（四位數字連號，**已合併的 migration 不要修改**）。純 SQL，語句可用 `--> statement-breakpoint` 分隔；啟動時自動套用。需要的 trigger / uid 欄位參考 `0005_uid.sql`。
4. **權限 capability 登錄**：在 `server/app/permissions.py` 的 `CAPABILITIES` 加入 `名稱: 最低角色`，在 `CAPABILITY_INFO` 補中文名稱 / 說明 / 分組；端點用 `Depends(require("名稱"))`；寫入類的一般協作路徑則加進 `WRITE_GUARDS`。受保護項目加進 `PROTECTED_CAPABILITIES`。前端名稱表 `src/shared/permissions.ts` 要同步（pytest 會比對兩邊一致）。新 capability 不需 migration，自動採預設。更新 [permissions.md](permissions.md) 的矩陣。
5. **前端 feature 資料夾**：`src/web/features/<name>/` 放頁面元件、`api.ts`（fetch 與 TanStack Query hooks）、`model.ts`（純邏輯，附 `model.test.ts`）、`<name>.css`；在 `src/web/routes.tsx` 註冊路由、`src/shared/<name>.ts` 放 zod schema；導覽項目依 capability 以 `useCan()` 顯示。
6. **介面規格**：先在 `docs/design/<name>.md` 寫規格（現有 15 份可參考）。
7. **測試**：後端 `server/tests/test_<name>.py`（pytest，共用設定在 `server/tests/conftest.py`、`helpers.py`）；前端純邏輯 vitest；關鍵流程加 `tests/e2e/<name>.spec.ts`，帳號用 `tests/helpers/e2eUsers.ts`。新增的環境變數要同時寫進 `config.py`、`.env.example`、README 的環境變數表。
8. 新增功能前先對照 [product-principles.md](product-principles.md)（尤其總覽相關：不排名、不比較）。

## 14. 開發流程紀錄

專案以 `parallel-dev-orchestrator` 流程開發：先有 PLAN.md（經使用者審核）；核心分支先行（foundation → auth-data → shell），共用的資料表、路由掛載點、相依套件一次建好；其餘功能每條軌道一個 `git worktree`（獨立 `PORT`、獨立 DB 檔），只改自己的 `features/<name>`，避免互踩；完成後以 **`git merge --ff-only`** 合併回 `main`（保持線性歷史）並立即清理 worktree 與分支；hotfix 另開 `hotfix/<topic>` 同樣 ff-only。每輪結束更新 PROGRESS.md。目前只剩主 worktree 與 `main`；這份交接文件在 `docs/handoff` 分支，未合併。

## 15. 文件索引

| 文件                                             | 內容                                         |
| ------------------------------------------------ | -------------------------------------------- |
| [../README.md](../README.md)                     | 快速開始、環境變數表、從零部署、備份、常見問題 |
| [MOVE-TO-SERVER.md](MOVE-TO-SERVER.md)          | 本機資料搬到 server 的逐步教學（已演練）     |
| [permissions.md](permissions.md)                 | 角色、預設矩陣、受保護項目、端點對照         |
| [multi-user.md](multi-user.md)                   | 多人架構、閒置計時、在線感知、併發測試       |
| [sync.md](sync.md)                               | 多台電腦 sync-push 設計                      |
| [product-principles.md](product-principles.md)   | 產品原則（總覽不評比）                       |
| [core-interfaces.md](core-interfaces.md)         | 核心介面                                     |
| [design/](design)                                | 各頁面介面規格                               |
| [design/task-discussion.md](design/task-discussion.md) | 任務討論區、捲軸設計與描述鎖定        |
| `../PROGRESS.md`、`../PLAN.md`                   | 進度與原始規劃（PLAN 內的 TS 後端為歷史紀錄） |

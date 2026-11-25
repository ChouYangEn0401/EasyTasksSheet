# 設計規格 — 工程追蹤（簡化版）

> 這是**紀錄工具**，手動輸入為主；GitHub 連動為**選配**（需 `GITHUB_TOKEN`，見 §6），一切從簡。被追蹤的專案視為在**各人自己的電腦**上；
> 伺服器只有在管理者明確啟用「掃描本機專案」（`WORKTREE_SCAN_ROOTS`，§11）時，才會對允許的資料夾執行**唯讀** git 指令。
> 後端：Python（`server/app/features/eng.py`、`eng_status.py`、`server/app/worktree_scan.py`）。
> v2（feat/eng-v2）：可自訂狀態（§10）、一鍵掃描本機專案（§11）、多台電腦回報「不見不等於刪除」（§12）、回收區（§13）。
> 舊版（repo 管理、server 端 git 偵測、GitHub issue 快取）已隨 TS 後端一併移除。

適用：`src/web/features/eng/**`，路由 `/eng`。token 與基礎元件一律引用 `core-shell.md`，不新增 token、不新增基礎元件。

優先順序：**手動輸入** → 各人電腦回報、server 集中保存 → 本機路徑只作為記錄欄位 / 回報腳本用 → GitHub 連動（選配，見 §6）。

頁面兩個分頁（URL `?tab=worktrees`，預設為「問題」）：

| 分頁                     | 計數       | 附註                                               |
| ------------------------ | ---------- | -------------------------------------------------- |
| 問題                     | 未結案筆數 | 每列可展開：說明全文、連結預覽、附件區（§8、§9）   |
| 工作樹（git worktree）   | 紀錄筆數   | 有「可能遺失 / 未登記」提示時顯示 warning 計數膠囊 |

每列顯示 `UpdatedAt`（hover 顯示更新者）。

## 1. 問題

任何成員可新增、編輯、結案、刪除。

| 欄位        | 說明                                               |
| ----------- | -------------------------------------------------- |
| 標題        | 必填，200 字內                                     |
| 專案 / Repo | 自由文字（100 字內）；輸入框提供既有名稱的下拉建議 |
| 狀態        | 可自訂（§10）；內建：未處理、處理中、卡住、延後、已結案、不處理 |
| 負責人      | 成員或未指派                                       |
| 連結        | 選填，http(s) 網址；GitHub issue 網址會自動解析    |
| 說明        | 選填，5000 字內                                    |

- **新增表單放最上面**：填標題即可按 Enter 送出；送出後標題清空，專案與負責人保留，方便連續登錄。
- 清單：未結案在前、依更新時間新到舊；預設隱藏已結案，勾「顯示已結案（N）」才列出。
- 列上直接以下拉改狀態（一步完成）；「⋯」選單：編輯（對話框）、結案 / 重新開啟、刪除（確認，附件一併刪除）。
- 列首的 ▸ 展開按鈕（或點標題）展開詳細列：說明全文、連結預覽卡片（§9）、附件區（§8）。收合時標題旁以「迴紋針 N」小標記顯示附件數（上傳中另標 +N）。
- 列表容器**不設 overflow**（否則「⋯」選單與狀態下拉會被裁切、出現小捲軸）；窄螢幕改為卡片式排版而非水平捲動。

## 2. Worktree 紀錄

任何成員可新增、編輯、移到回收區（§13）；狀態一律**手動**（回報與掃描都不會自動改狀態）。

| 欄位   | 說明                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 電腦   | 必填；worktree 所在的電腦名稱（新增表單記住上次填的值，並提供既有名稱建議） |
| 路徑   | 必填；該電腦上的路徑（純文字，不檢查是否存在）                             |
| 分支   | 選填                                                                       |
| 負責人 | 成員或未指派                                                               |
| 用途   | 選填，200 字內                                                             |
| 狀態   | 可自訂（§10）；內建：使用中／閒置／已合併待清理／損毀／技術債／舊版保留／未知／已遺失／已清理 |
| 備註   | 選填（編輯對話框）                                                         |

- 同一台電腦（不分大小寫）的同一路徑（斜線方向、Windows 大小寫正規化）只能有一筆，重複時 409「此電腦的這個路徑已有紀錄」。
- 清單依**電腦**分組（各為一張卡片），標題列顯示「回報於 …」或「尚未回報（僅手動紀錄）」。

## 3. 各人電腦回報（集中管理）

- 在各人電腦的 repo 目錄執行 `node scripts/report-worktrees.mjs --server <網址>`
  （`--machine` 預設為主機名稱、`--repo` 預設為 repo 目錄名稱、`--dry-run` 只印出不送出）。
  腳本只依賴 Node 內建模組，讀取 `git worktree list` 與各 worktree 的 dirty、相對 main/master 的 ahead/behind、是否已併入。
- 端點 `POST /api/eng/worktrees/report`：免登入，只以 `X-Report-Token` 或 `Authorization: Bearer` 對 `WORKTREE_REPORT_TOKEN` 做固定時間比較；**未設定一律 403**；仍須 `Content-Type: application/json`。以電腦識別碼 + repo 為單位更新快照（**不刪除**，見 §12）。
- 比對（僅供參考，不會自動改紀錄）：
  - **可能遺失**：紀錄有、但該電腦的回報裡從未出現此路徑（電腦從未回報、或紀錄狀態屬「已結束」類時不提示）。列左緣 danger 色條。
  - **回報中找不到（上次看到 N 天前）**、**可能是搬動 / 改名**：見 §12。
  - **未登記**：回報有、但沒有紀錄；列左緣 warning 色條，提供「登記」按鈕一鍵建立紀錄（已併入者預設「已合併待清理」）。
- 有紀錄的列在「回報快照」欄顯示摘要，例如「未提交變更 · ↑2 ↓0 · 已併入 main」。
- 伺服器未設定 token 時，頁面顯示一行說明（自動回報停用，手動紀錄不受影響）。

## 4. API（`/api/eng`）

| 方法與路徑                                          | 說明                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /issues`                                       | `{ githubEnabled, syncMinutes, links, issues }`（不做網路呼叫）                        |
| `POST /issues/sync`、`POST /issues/import`、`POST /issues/:id/publish`、`PUT /github-links` | GitHub 連動（見 §6；未設定 token 一律 503）                      |
| `POST /issues`、`PATCH /issues/:id`、`DELETE …`      | 新增 / 只送改動欄位 / 刪除                                                             |
| `GET /worktrees`                                    | `{ reportEnabled, staleDays, trashCount, scan, machines: [{ key, machine, machineId, reportedAt, stale, repos(+pending), records(+hint/lastSeenAt/moveTo), reports(+registered/movedFrom) }] }` |
| `POST /worktree-records`、`PATCH …/:id`、`DELETE …` | 紀錄新增 / 修改 / 移到回收區（軟刪除）                                                 |
| `GET /worktree-records/trash`、`POST …/:id/restore`、`POST …/trash/purge` | 回收區清單 / 還原 / 永久清空（§13）                              |
| `POST /worktrees/report`                            | 回報（見 §3、§12）                                                                     |
| `POST /worktrees/pending/:sourceId/accept`、`…/discard` | 確認採用 / 忽略被攔下的可疑回報（§12）                                             |
| `POST /worktrees/scan`、`POST /worktrees/scan/apply` | 掃描本機專案：預覽（不寫入）/ 登記勾選項目（§11）                                    |
| `GET /statuses?kind=`、`POST /statuses`、`PATCH /statuses/:id`、`DELETE /statuses/:id` | 可自訂狀態（§10）                                     |
| `POST /issues/:id/attachments`                      | 上傳附件（multipart/form-data，可多檔；見 §8）                                         |
| `POST /issues/:id/preview`                          | 重新取得連結預覽（見 §9）                                                              |
| `GET /api/attachments/:id`、`GET …/:id/thumb`、`DELETE …/:id` | 附件下載（支援 Range）/ 圖片縮圖 / 刪除（路徑在 `/api/attachments`，非 `/api/eng`） |

`GET /issues` 另回傳 `attachments`（問題 id → 附件清單）、`previews`（問題 id → 預覽）、`attachmentLimits`、`linkPreviewEnabled`。

資料表（`server/migrations/0002_eng_manual.sql`、`0004_eng_github.sql`、`0008_attachments.sql`、`0011_eng_v2.sql`）：`manual_issues`（含 `github_*` 欄位）、`worktree_records`（0011 加 `machine_id`、`source`、`repo`、`head_sha`、`deleted_at`、`deleted_by`）、`worktree_reports`（0011 加 `machine_id`、`missing_since`）、`worktree_report_sources`、`eng_statuses`、`eng_github_links`、`attachments`、`link_previews`。
即時同步沿用既有實體類型：問題與回報記為 `repo`、紀錄記為 `worktree_plan`（前端皆對應 `['eng']`）。
型別：`src/shared/engManual.ts`。

## 5. 響應式

`< 1024px`：新增表單改兩欄（標題 / 路徑佔滿一列），負責人只顯示頭像；表格改為**卡片式**（每列換行排列：展開鈕 + 標題 + ⋯ 一行，其餘欄位下一行），不水平捲動，選單不會被裁切。
`< 640px`：新增表單單欄；附件縮圖格縮小。分頁列可左右捲動，不會被切掉。

## 6. GitHub 連動（選配）

只有伺服器 `.env` 設定 `GITHUB_TOKEN` 才啟用（`githubEnabled`）；未設定時畫面不出現任何 GitHub 按鈕，行為與純手記相同。token 只在 server 端使用，不回傳前端。

優先順序：手動 → 自動更新狀態 → 專案連動 → 建立 issue。

- **網址解析（不需 token）**：新增 / 編輯問題時，「連結」若為 `https://github.com/<owner>/<repo>/issues/<n>`，後端記錄 `githubRepo`（小寫）與 `githubNumber`；問題列標題旁顯示 `#編號` 小標記，滑過顯示 repo、GitHub 狀態與同步時間。pull request 網址不解析。連結改成其他網址時清空 GitHub 欄位。
- **同步**（`POST /issues/sync`，body `{}` 或 `{ id }`）：向 GitHub 取回狀態與標題。規則：只在 **GitHub 端有變動**時覆蓋本地——GitHub 關閉 → 已結案；GitHub 重開（closed → open）→ 未處理；GitHub 標題與上次同步的不同 → 覆蓋本地標題（第一次同步不覆蓋）。GitHub 無變動時，本地手動改的狀態不會被蓋回。單筆失敗不影響其他筆（回傳 `failed`）。
  - 前端：列表載入時若有 GitHub 問題的同步時間超過 `GITHUB_SYNC_MINUTES`（預設 5），自動同步一次（同頁面最多每 N 分鐘一次）；貼上 GitHub 網址存檔後立即同步該筆。工具列「同步 GitHub」手動同步。
- **專案連動**（`PUT /github-links`，整批取代）：問題的「專案 / Repo」名稱（不分大小寫）→ `owner/name`。工具列「GitHub 連動 / 匯入」開小對話框編輯，任何成員可改。
- **從 GitHub 匯入**（`POST /issues/import`，body `{ project }`）：匯入該 repo 開啟中的 issue（略過 PR），以 repo + 編號去重。
- **在 GitHub 建立**（`POST /issues/:id/publish`）：問題「⋯」選單出現於「尚未連結 GitHub 且專案已連動」時；以標題 / 說明建立，成功後寫回連結與編號。
- 錯誤：未設定 token → 503；GitHub 端錯誤（token 無效、權限不足、找不到、逾時）→ 502 中文訊息。網路呼叫一律有逾時，且不在 GET 內進行。
- 實作：`server/app/github.py`（標準庫 urllib；測試以 `app.state.github_client` 注入假用戶端）。

## 7. 未實作

- **整頁網頁截圖**：連結預覽目前只提供 metadata（標題、說明、og:image、favicon、網站名稱、前 300 字摘要），**不含整頁截圖**（需要伺服器端無頭瀏覽器，風險與資源成本高）。
- 影片轉檔與伺服器端影片縮圖：不做（縮圖格用 `<video preload="metadata">` 的第一幀）。
- 伺服器端 git 偵測（舊版模式 A）：不移植（v2 的「掃描本機專案」是管理者手動觸發、限定資料夾的唯讀掃描，見 §11）。
- GitHub Enterprise 的 issue 網址解析（API 位址可用 `GITHUB_API_URL` 指定，但網址解析只認 github.com）。

## 8. 附件（圖片、影片、音訊、檔案）

通用機制（`attachments` 表：`entity_type` + `entity_id`），目前接到工程問題（`manual_issue`），之後可擴到任務。後端：`server/app/attachments.py`（白名單、驗證、串流接收）、`server/app/features/eng_attach.py`（API）。

- **權限**：登入成員即可上傳 / 下載 / 刪除。
- **存放**：`ATTACHMENTS_DIR`（預設 `data/attachments`），檔名為隨機 32 碼 hex，**不使用使用者檔名**；使用者檔名只當顯示文字（去除路徑與控制字元，`../evil.png` → `evil.png`），下載時路徑必須在目錄內。
- **白名單**（依副檔名，並以內容魔術數字驗證；回應 Content-Type 取自白名單，不信任瀏覽器送的值）：
  圖片 png / jpg / gif / webp；影片 mp4 / webm / mov（ISO BMFF `ftyp`、EBML + `webm` doctype）；音訊 mp3 / wav / m4a；pdf（`%PDF-`）；文字 txt / md / csv / json / log（不得含 NUL）；zip；Office docx / xlsx / pptx / odt / ods / odp（zip 容器）、doc / xls / ppt（OLE）。**SVG 不允許**（可能含 script）；就算資料庫中有，下載也一律 `attachment`。
- **上限**：一般檔案 `ATTACHMENT_MAX_MB`（預設 25）、影片 `ATTACHMENT_VIDEO_MAX_MB`（預設 200）、每筆 `ATTACHMENT_MAX_PER_ITEM`（預設 10）。超限 413 / 400 中文訊息。
- **串流寫入**：python-multipart 串流 parser 逐塊寫入同目錄 `.tmp-*`，邊寫邊算 SHA-256；超過上限立即中止並刪除暫存檔；一批中任一檔不合格則整批不寫入。`Content-Length` 明顯超過上限時直接 413。
- **CSRF**：只有 `POST /api/eng/issues/:id/attachments` 可用 `multipart/form-data`（`security.MULTIPART_UPLOAD_PATHS`），且**必須**帶同源 `Origin`（其他端點仍只收 JSON）。
- **下載**：`X-Content-Type-Options: nosniff`、`Content-Security-Policy … sandbox`（PDF 除外，瀏覽器 PDF 檢視器在 sandbox 下無法顯示）；圖片 / 影片 / 音訊 / PDF `inline`，其餘 `attachment`（`?download=1` 一律下載）。支援 **HTTP Range**（206 / `Accept-Ranges` / `Content-Range`，含 suffix range；非法或超出檔尾的範圍 416），影片可拖曳進度條。
- **縮圖**：`/thumb` 只給圖片；安裝 Pillow 時產生 480px WebP，否則回傳原圖由 CSS 縮放（不強制新增相依）。
- **刪除**：`DELETE /api/attachments/:id`（確認對話框）；刪除問題時 trigger 一併刪除資料列，API 刪除檔案。匯入「取代模式」刪除問題後殘留的檔案可用 `python -m server.cli attachments-prune` 清除。
- 變更紀錄：上傳 / 刪除附件記為該問題的 `repo` update（其他人畫面即時更新）。
- **前端**（`Attachments.tsx`、`uploads.ts`）：
  - 附件區頂部是虛線拖放區（圖示 +「拖放檔案到這裡，或點此選擇；也可以直接貼上圖片」+ 上限說明），可 Tab 聚焦、Enter / Space 開啟檔案選擇器；已有附件時縮為一行。
  - 縮圖格：圖片縮圖、影片第一幀 + 播放圖示 + 時長、其他依類型圖示（PDF / 文件 / 壓縮檔 / 文字 / 音訊）與副檔名標籤；檔名過長中間省略；大小 · 上傳者 · 時間。hover / focus 顯示下載與刪除（觸控裝置常駐）。
  - 上傳：每個檔案一個請求，佔位卡片顯示進度條與取消鈕；失敗卡片顯示原因與「重試」/「移除」；多檔同時上傳；上傳中離開頁面會提示。前端先檢查類型 / 大小 / 數量。
  - 說明欄（新增表單、編輯對話框）可直接 Ctrl+V 貼上圖片：編輯時立即上傳；新增表單先列為待上傳，建立後自動上傳並展開該列。
  - 燈箱（原生 `<dialog>`）：圖片、`<video controls preload="metadata" playsinline>`、`<audio controls>`、PDF 內嵌，其他提供下載；← → 切換同一問題的附件，Esc 關閉（暫停播放）。
- **備份**：`python -m server.cli backup` 依備份當下的資料庫快照，把附件檔一併備份到 `<備份檔>.attachments/`（同磁碟以硬連結節省空間），保留份數同步清理；`restore` 同步還原附件目錄（原目錄保留為 `.before-restore-*`）。JSON 匯出只含附件清單元資料（`attachments`），不含檔案本體——附件檔案請用完整備份帶走。

## 9. 連結預覽（網頁 metadata）

「連結」存入 / 變更時（回應送出後於 threadpool 背景抓取，失敗不影響問題的儲存），或按「重新取得預覽」（`POST /issues/:id/preview`）時，後端抓取網頁的 title、description、og:image、favicon、site name 與前 300 字純文字摘要，存在 `link_previews`（含 `fetched_at`）。GitHub issue 連結沿用 GitHub 同步，不抓預覽。**不含整頁截圖。**

- 展開列中顯示預覽卡片：縮圖、標題、說明（兩行）、網站 / 網域與 favicon；點擊開新分頁（`rel="noopener noreferrer"`）；外部圖片以 `referrerPolicy="no-referrer"` 載入，失敗即隱藏。失敗時顯示「無法取得預覽（原因）」與重試按鈕。
- **SSRF 防護**（`server/app/link_preview.py`）：
  - 只允許 http / https，網址不得含帳密；主機名解析後**所有** IP 都必須是公開位址：拒絕 127/8、10/8、172.16/12、192.168/16、169.254/16（含雲端 metadata）、100.64/10、0/8、保留 / 文件 / 多播段、`::1`、`::`、`fc00::/7`、`fe80::/10`、IPv4-mapped / NAT64 / 6to4 / Teredo 內嵌的私有 IPv4；十進位（`2130706433`）、十六進位（`0x7f000001`）、八進位（`0177.0.0.1`）、簡寫（`127.1`）一律以 inet_aton 規則解析後檢查；`localhost` / `*.localhost` 直接拒絕。
  - 連線時直接連到**已驗證的 IP**（HTTP 帶原 Host、HTTPS 以 SNI 與憑證驗證原主機名），避免 DNS rebinding。
  - 重新導向最多 3 次，**每次重新驗證**；逾時：連線 5 秒、整體 10 秒；回應最多讀 1 MB；只解析 `text/html`（其他類型只記錄 content-type 與網域）；不帶 cookie / 認證、`Accept-Encoding: identity`、明確的 User-Agent；不執行 JS；以標準庫 `html.parser` 解析，輸出一律純文字（前端以文字節點顯示）。
- 設定：`LINK_PREVIEW_ENABLED`（預設 true）；`LINK_PREVIEW_ALLOW_PRIVATE`（預設 false，**開啟後可抓內網位址，有 SSRF 風險**，只建議用於 E2E 測試或完全隔離的內網部署）。
- 測試可注入：`app.state.link_fetcher`（假抓取器）、`SafeFetcher(resolver=…, transport=…, clock=…)`。
## 10. 可自訂狀態（問題 / 工作樹）

- 資料表 `eng_statuses`：`kind`（issue | worktree）、`key`（穩定識別；資料中存的就是 key）、`label`、`color`（TAG_COLORS 八色）、`category`、`sort_order`、`is_builtin`、`is_archived`、`uid`、`updated_at/by`。
- 類別：問題 `open`（未結案）/ `closed`（已結案）；工作樹 `active`（使用中）/ `idle`（閒置）/ `attention`（需處理）/ `done`（已結束）。
  「顯示已結案」「顯示已清理」切換、未結案計數、清單排序（已結案類在後）、GitHub 同步的結案 / 重開判斷都依**類別**，不依固定字串。
- 內建（migration 0011 回填，既有資料的值不需改）：
  - 問題：`open` 未處理、`doing` 處理中、`blocked` 卡住、`deferred` 延後（以上 open）；`closed` 已結案、`wontfix` 不處理（closed）
  - 工作樹：`active` 使用中；`idle` 閒置、`legacy` 舊版保留（idle）；`merged` 已合併待清理、`broken` 損毀、`tech_debt` 技術債、`unknown` 未知（attention）；`lost` 已遺失、`cleaned` 已清理（done）
- 規則：內建可改名 / 改色 / 排序 / 封存，key 與類別不可改、不可刪除；自訂（key `c_xxxxxxxx`）無資料使用時可刪除，使用中只能封存（409）；同類名稱不可重複；每類至少保留一個未封存狀態。
  封存的狀態不出現在新選單，但舊資料照常顯示、可保留（PATCH 送同一值不會被拒），**不可新設**。寫入的狀態值必須存在於 `eng_statuses`（400）。
- 新增時未指定狀態：用內建預設（問題 `open`、工作樹 `active`），被封存時改用同類別第一個未封存者。
- 權限：讀取全員；寫入 `eng.status.manage`（預設 user 以上——使用者希望「讓人自己建立」；root 可在權限設定頁調整）。
- 前端：所有狀態下拉由 `/api/eng/statuses` 驅動（`EngStatus.tsx`）；選單底部「＋ 新增狀態…」（新增後直接套用到該列）與「管理狀態…」，工具列也有「管理狀態」。管理對話框：行內改名、選色、類別（自訂才可改）、上移 / 下移、封存 / 取消封存、刪除（自訂且未使用）。無權限者看不到管理入口。
- 匯出 / 匯入：問題與工作樹紀錄的狀態欄改為自由字串（≤100），工作樹紀錄另帶 `machineId`、`source`、`repo`、`headSha`、`deletedAt`（舊匯出檔缺少時用預設值）。`eng_statuses` 本身目前**不在 JSON 匯出範圍**：匯入到另一台時自訂狀態會以 key 顯示（灰色），可在管理狀態重新建立。

## 11. 掃描本機專案（一鍵登記 worktree）

- **網頁**：工作樹分頁「掃描本機專案」（需 `eng.scan`，預設 manager 以上）。輸入或貼上專案資料夾（記住最近 5 個）、電腦名稱（預設為伺服器這台）→「預覽」列出 新發現 / 已登記 / 可能搬動（含 dirty、↑↓、已併入、目錄不存在）→ 勾選後「登記（N）」。
  - `POST /api/eng/worktrees/scan`（預覽，不寫入）；`POST /api/eng/worktrees/scan/apply`（**重新掃描**，不採信前端內容，只套用勾選的路徑）：新發現 → 新增紀錄（來源 `scan`、已併入者為「已合併待清理」）；可能搬動 → 更新該紀錄的路徑；已登記 → 更新分支與 HEAD。
- **CLI**：`python -m server.cli scan-worktrees <專案資料夾> [--machine 電腦名稱] [--repo 專案名稱] [--db 資料庫] [--dry-run] [--yes]`。列出三類後詢問 `[y/N]`（`--yes` 直接登記新發現與路徑改變），`--dry-run` 只列出。在操作者自己的電腦執行，不受 `WORKTREE_SCAN_ROOTS` 限制；電腦識別碼取自 `~/.tasks-sheets/machine.json`（與回報腳本共用，不存在時建立）。
- **安全**（`server/app/worktree_scan.py`）：
  - 只允許 `WORKTREE_SCAN_ROOTS`（逗號分隔）內的路徑；以 `realpath` 解開 `..` 與符號連結後比對（Windows 不分大小寫）；**未設定 = 功能停用**（API 409 `SCAN_DISABLED`，介面說明如何啟用）。需為絕對路徑。
  - git 以 `subprocess.run` 參數陣列執行（無 shell）、`GIT_TIMEOUT_MS` 逾時、stdin 關閉；`-c core.fsmonitor=false -c core.hooksPath= -c core.pager=cat -c diff.external= -c core.sshCommand= -c credential.helper= -c protocol.allow=never -c core.untrackedCache=false …`、`--no-optional-locks`；環境變數白名單（PATH、HOME 等）＋ `GIT_OPTIONAL_LOCKS=0`、`GIT_TERMINAL_PROMPT=0`、`GIT_PAGER=cat`。
  - 只允許唯讀子指令：`worktree list --porcelain`、`status --porcelain`、`rev-list --left-right --count`、`merge-base --is-ancestor`、`log -1 --format=%ct`、`rev-parse --verify / --show-toplevel`、`reflog show`（判斷剛建立的分支）；不 fetch、不執行 hook。單一輸出上限 1 MB、最多 200 個 worktree。
  - 限制：repo 自己的 `.git/config` 若定義 clean filter，`git status` 仍可能執行它——因此只開放給管理者設定的可信資料夾。

## 12. 多台電腦回報：不見不等於刪除

- **電腦識別碼**：`scripts/report-worktrees.mjs` 第一次執行在 `~/.tasks-sheets/machine.json`（可用 `TASKS_SHEETS_HOME` 改位置）產生隨機 `machineId` 與可編輯的 `machineName`，之後每次回報帶 `machineId` + 名稱。伺服器以 `machineId` 為分組鍵（`id:<machineId>`），名稱只是顯示用：改名或兩台同名都不會混淆。舊版腳本沒有 id → 以名稱暫代（`name:<小寫名稱>`）；同名的新版腳本第一次帶 id 回報時接手這些舊資料（只接手沒有 id 者）。
- **只標記、不刪除**：同一電腦 + repo 的回報以路徑比對更新；這次沒出現的項目只寫 `missing_since`，快照列與紀錄一律保留。頁面顯示：
  - 電腦超過 `WORKTREE_STALE_DAYS`（預設 2）天沒回報 →「未回報（最後看到 3 天前）」；
  - 紀錄在最新回報中找不到 →「回報中找不到（上次看到 N 天前）」。
  - **系統任何流程都不會自動刪除 worktree 紀錄**（回報、確認回報、掃描皆然；pytest `test_report_flows_never_delete_records_or_snapshots`）。
- **防誤清空**：新回報若是空清單、但該電腦（該 repo）先前有資料；或筆數減少超過一半且減少 ≥ 5 筆 → 視為可疑：**不套用**，整份存到 `worktree_report_sources.pending_*`，回應 `{ held: true, reason: "empty" | "drop", message }`（腳本印出提醒）。頁面該電腦卡片顯示「可疑回報待確認」與說明，有 `eng.edit` 者可按「確認採用這次回報」（照一般規則套用：不見的只標記）或「保留舊資料」（忽略）。之後若收到正常的回報，會直接套用並清除待確認。
- **搬動不誤判**：紀錄的路徑不在最新回報，但同電腦有一個未登記的項目**分支與 HEAD 相同** → 紀錄提示「可能是搬動 / 改名 → 新路徑」並提供「更新路徑」一鍵修正；該未登記項目不再另列（不會出現「一筆遺失 + 一筆未登記」）。HEAD 來源：上次回報的快照，或掃描 / 登記時寫入紀錄的 `head_sha`。
- **頁面**：依電腦分組，卡片標題列為電腦名稱（`#識別碼前 6 碼`）、可疑 / 未回報標記、最後回報時間；工具列「顯示已清理（N）」切換「已結束」類紀錄。

## 13. 回收區（刪除要明確且可還原）

- 「⋯ → 移到回收區」為軟刪除（`deleted_at`、`deleted_by`）；回收區對話框（工具列「回收區（N）」）列出已刪除紀錄，可「還原」（同電腦同路徑已有紀錄時 409）。
- 超過 30 天只標示「已超過 30 天」，**仍不自動清除**、仍可還原；只有具 `eng.trash.purge`（預設 manager 以上）者按「清空回收區」→ 確認「永久刪除」才會真正刪除（API 需 body `{ "confirm": true }`）。
- 回收區中的紀錄不參與比對與重複路徑檢查；狀態的「使用中筆數」仍計入（還原後會用到）。
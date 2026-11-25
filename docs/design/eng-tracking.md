# 設計規格 — 工程追蹤（簡化版）

> 這是**紀錄工具**，手動輸入為主；GitHub 連動為**選配**（需 `GITHUB_TOKEN`，見 §6），一切從簡。被追蹤的專案視為在**各人自己的電腦**上，
> 伺服器不執行任何 git 指令。後端：Python（`server/app/features/eng.py`）。
> 舊版（repo 管理、server 端 git 偵測、GitHub issue 快取）已隨 TS 後端一併移除。

適用：`src/web/features/eng/**`，路由 `/eng`。token 與基礎元件一律引用 `core-shell.md`，不新增 token、不新增基礎元件。

優先順序：**手動輸入** → 各人電腦回報、server 集中保存 → 本機路徑只作為記錄欄位 / 回報腳本用 → GitHub 連動（選配，見 §6）。

頁面兩個分頁（URL `?tab=worktrees`，預設為「問題」）：

| 分頁     | 計數       | 附註                                               |
| -------- | ---------- | -------------------------------------------------- |
| 問題     | 未結案筆數 |                                                    |
| Worktree | 紀錄筆數   | 有「可能遺失 / 未登記」提示時顯示 warning 計數膠囊 |

每列顯示 `UpdatedAt`（hover 顯示更新者）。

## 1. 問題

任何成員可新增、編輯、結案、刪除。

| 欄位        | 說明                                               |
| ----------- | -------------------------------------------------- |
| 標題        | 必填，200 字內                                     |
| 專案 / Repo | 自由文字（100 字內）；輸入框提供既有名稱的下拉建議 |
| 狀態        | 未處理（open）／處理中（doing）／已結案（closed）  |
| 負責人      | 成員或未指派                                       |
| 連結        | 選填，http(s) 網址；GitHub issue 網址會自動解析    |
| 說明        | 選填，5000 字內                                    |

- **新增表單放最上面**：填標題即可按 Enter 送出；送出後標題清空，專案與負責人保留，方便連續登錄。
- 清單：未結案在前、依更新時間新到舊；預設隱藏已結案，勾「顯示已結案（N）」才列出。
- 列上直接以下拉改狀態（一步完成）；「⋯」選單：編輯（對話框）、結案 / 重新開啟、刪除（確認）。

## 2. Worktree 紀錄

任何成員可新增、編輯、刪除；狀態一律**手動**。

| 欄位   | 說明                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 電腦   | 必填；worktree 所在的電腦名稱（新增表單記住上次填的值，並提供既有名稱建議） |
| 路徑   | 必填；該電腦上的路徑（純文字，不檢查是否存在）                             |
| 分支   | 選填                                                                       |
| 負責人 | 成員或未指派                                                               |
| 用途   | 選填，200 字內                                                             |
| 狀態   | 使用中／閒置／已合併待清理／已遺失／已清理                                 |
| 備註   | 選填（編輯對話框）                                                         |

- 同一台電腦（不分大小寫）的同一路徑（斜線方向、Windows 大小寫正規化）只能有一筆，重複時 409「此電腦的這個路徑已有紀錄」。
- 清單依**電腦**分組（各為一張卡片），標題列顯示「回報於 …」或「尚未回報（僅手動紀錄）」。

## 3. 各人電腦回報（集中管理）

- 在各人電腦的 repo 目錄執行 `node scripts/report-worktrees.mjs --server <網址>`
  （`--machine` 預設為主機名稱、`--repo` 預設為 repo 目錄名稱、`--dry-run` 只印出不送出）。
  腳本只依賴 Node 內建模組，讀取 `git worktree list` 與各 worktree 的 dirty、相對 main/master 的 ahead/behind、是否已併入。
- 端點 `POST /api/eng/worktrees/report`：免登入，只以 `X-Report-Token` 或 `Authorization: Bearer` 對 `WORKTREE_REPORT_TOKEN` 做固定時間比較；**未設定一律 403**；仍須 `Content-Type: application/json`。同一電腦 + repo 的快照整批取代。
- 比對（僅供參考，不會自動改紀錄）：
  - **可能遺失**：紀錄有、但該電腦最新回報裡沒有此路徑（電腦從未回報、或紀錄狀態為已遺失 / 已清理時不提示）。列左緣 danger 色條。
  - **未登記**：回報有、但沒有紀錄；列左緣 warning 色條，提供「登記」按鈕一鍵建立紀錄（已併入者預設「已合併待清理」）。
- 有紀錄的列在「回報快照」欄顯示摘要，例如「未提交變更 · ↑2 ↓0 · 已併入 main」。
- 伺服器未設定 token 時，頁面顯示一行說明（自動回報停用，手動紀錄不受影響）。

## 4. API（`/api/eng`）

| 方法與路徑                                          | 說明                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /issues`                                       | `{ githubEnabled, syncMinutes, links, issues }`（不做網路呼叫）                        |
| `POST /issues/sync`、`POST /issues/import`、`POST /issues/:id/publish`、`PUT /github-links` | GitHub 連動（見 §6；未設定 token 一律 503）                      |
| `POST /issues`、`PATCH /issues/:id`、`DELETE …`      | 新增 / 只送改動欄位 / 刪除                                                             |
| `GET /worktrees`                                    | `{ reportEnabled, machines: [{ machine, reportedAt, records(+hint), reports(+registered) }] }` |
| `POST /worktree-records`、`PATCH …/:id`、`DELETE …` | 紀錄 CRUD                                                                              |
| `POST /worktrees/report`                            | 回報（見 §3）                                                                          |

資料表（`server/migrations/0002_eng_manual.sql`、`0004_eng_github.sql`）：`manual_issues`（含 `github_*` 欄位）、`worktree_records`、`worktree_reports`、`eng_github_links`。
即時同步沿用既有實體類型：問題與回報記為 `repo`、紀錄記為 `worktree_plan`（前端皆對應 `['eng']`）。
型別：`src/shared/engManual.ts`。

## 5. 響應式

`< 1024px`：新增表單改兩欄（標題 / 路徑佔滿一列），負責人只顯示頭像；表格可橫向捲動。

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

- 伺服器端 git 偵測（舊版模式 A）：不移植。
- GitHub Enterprise 的 issue 網址解析（API 位址可用 `GITHUB_API_URL` 指定，但網址解析只認 github.com）。
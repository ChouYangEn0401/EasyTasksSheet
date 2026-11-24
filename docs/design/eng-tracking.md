# 設計規格 — feat/eng-tracking（T6，輕量）

適用：`src/web/features/eng/**`，路由 `/eng`。token 與基礎元件一律引用 `core-shell.md`（下稱 core），本文件**不新增 token、不新增基礎元件**。

## 1. 版面

```
 [Issues 12]  [Worktrees 7 ⚠3]                    [Repo：tasks-sheets ▾] [⚙ 管理 repo*]
 ─────────
 （Issues）  上次同步 3 分鐘前                                   [↻ 重新整理]
  #142  登入頁在 Safari 版面跑掉      [bug] [frontend]   @alice   2 小時前   ↗

 （Worktrees）
  [全部 7] [遺失 1] [未登記 1] [已合併未清理 1] [未提交變更 2] [久未更新 1]   [+ 新增安排]
  狀態            分支 / 路徑                    負責人   關聯任務   實際狀態              更新    ⋯
  ● 遺失          feat/gantt                    (頭)王   #128 …    找不到此 worktree     3 天前  ⋯
                  ../TasksSheets-gantt
  ● 未登記        tmp/spike                     —        —         a1b2c3d ↑2 ↓0        昨天   [登記]
  ● 已合併未清理  feat/personal                 (頭)李   #131 …    f0e9d8c 已併入 main   5 天前  ⋯
  ● 正常 ◦未提交  feat/eng-tracking             (頭)陳   #140 …    9c8b7a6 ↑4 ↓1        剛剛   ⋯
```
\* 僅 `role=admin` 顯示。

- 分頁列沿用 core §6.1 ViewTabs 的外觀與 `<nav>` + `aria-current` 作法，標籤後附計數（`--text-xs` text-tertiary）；Worktrees 有異常時另附 `warning` 計數型 Badge。
- 狀態全在 URL：`?tab=issues|worktrees`（預設 `issues`）、`?repo=<id>`（預設第一個）、`?wt=<狀態鍵>`。
- 兩個清單皆為 surface 底、border、`--radius-lg` 的表格卡片；列高 `--row-height`（Worktree 列為兩行，高 56），列以 `--color-border-subtle` 分隔，hover 用 `--color-surface-hover`。

## 2. Issues 分頁

| 欄 | 內容 |
|---|---|
| 編號 | `#142`，`--font-mono` `--text-sm` text-secondary，寬 64 |
| 標題 | `--text-sm` text，單行截斷；為外部連結（新分頁開啟，`rel="noopener"`），hover 轉 accent-text 加底線 |
| 標籤 | Badge `neutral`，最多 3 個，其餘 `+N`（tooltip 列出）。**不採用來源端的標籤色碼** |
| 負責人 | `@login` `--text-sm` text-secondary（外部帳號，不用 Avatar）；無則「—」 |
| 更新 | `<UpdatedAt at={issue_updated_at}>` |
| 連結 | ghost `iconOnly` 外開圖示，`aria-label="在來源網站開啟 #142"` |

- 工具列：左側「上次同步 `<UpdatedAt at={fetched_at}>`」；右側 secondary 鈕「重新整理」（同步中為 loading，文字「同步中…」）。固定依更新時間新到舊排序。
- 狀態：
  - 載入：6 列 Skeleton。空（無未關閉 issue）：EmptyState「沒有未處理的 issue」。
  - **未設定 token**：EmptyState，圖示鑰匙，標題「尚未設定 issue 來源」，說明「請管理員在伺服器設定存取 token（見 `.env.example`）後重新啟動。」；不用錯誤樣式、不顯示重試鈕。
  - Repo 未設定 `remote_slug`：EmptyState「此 repo 未設定遠端來源」。
  - 同步失敗但有快取：保留列表，表格上方 warning-soft 提示列（core §5 提示列樣式）「同步失敗，目前顯示的是 {時間} 的資料」+「重試」。無快取時用 ErrorState。

## 3. Worktrees 分頁

### 3.1 狀態標示

每列有一個**主狀態**（互斥，依下表優先序取第一個符合者）與零到多個**附加旗標**。

| 鍵 | 文案 | 判定 | Badge tone | 色點 |
|---|---|---|---|---|
| `missing` | 遺失 | 有安排但實際不存在，或路徑已不在磁碟上（`is_prunable`） | `danger` | `--color-danger` |
| `unplanned` | 未登記 | 實際存在但沒有對應安排 | `warning` | `--color-warning` |
| `merged` | 已合併未清理 | 分支已併入 main 但 worktree 還在 | `accent` | `--color-info` |
| `ok` | 正常 | 以上皆非 | `success` | `--color-success` |
| 旗標 `dirty` | 未提交變更 | `is_dirty` | `neutral` | `--color-tag-orange` |
| 旗標 `stale` | 久未更新 | `last_commit_at` 超過 7 天 | `neutral` | `--color-tag-gray` |

- 顏色不是唯一線索：每個 Badge 都有文字；主狀態在前，旗標接在後方（間距 `--space-1`）。`missing` 不顯示旗標。
- 列排序固定：遺失 → 未登記 → 已合併未清理 → 帶旗標的正常 → 正常；同組內依分支名稱。異常列（前三種主狀態）左緣加 2px 同色直線，不加整列底色。

### 3.2 欄位

| 欄 | 內容 |
|---|---|
| 狀態 | 主狀態 Badge + 旗標 Badge |
| 分支 / 路徑 | 第一行分支 `--font-mono` `--text-sm`；第二行路徑 `--font-mono` `--text-xs` text-tertiary，過長時**從中間截斷**，tooltip 顯示完整路徑。有用途（`purpose`）時分支後加備註圖示，tooltip 顯示全文 |
| 負責人 | Avatar `sm` + 顯示名稱；未指派用 core 的未指派 Avatar |
| 關聯任務 | `#id 標題`（截斷），點擊呼叫 `openTask(id)`；無則「—」 |
| 實際狀態 | 第一行：短 SHA（7 碼 mono）+ `↑ahead ↓behind`（tabular-nums，0 時 text-tertiary）；第二行 `--text-xs` text-tertiary「最後提交 `<UpdatedAt at={last_commit_at}>`」。遺失列顯示「找不到此 worktree」danger-text；已合併列在 SHA 後加「已併入 main」 |
| 更新 | `<UpdatedAt at={reported_at} by={reported_by} prefix="偵測於">`；遺失列改用安排的 `updated_at` |
| 動作 | `⋯` ghost 選單：編輯安排／刪除安排／複製清理指令（僅已合併）。未登記列改為 secondary `sm` 鈕「登記」 |

- 篩選 chips 使用 Button `sm`：未選 `secondary`、已選為 accent-soft 底 + accent-text（同 core §6.2 已設定的觸發鈕樣式）；單選，計數為 0 的 chip 停用。
- 「複製清理指令」只把 `git worktree remove <path>` 與 `git branch -d <branch>` 複製到剪貼簿，**畫面不提供任何會執行 git 寫入的按鈕**；複製後選單項文字換為「已複製」1.5 秒。
- 狀態：載入 5 列 Skeleton；偵測失敗 ErrorState（顯示後端訊息）+ 重試；沒有安排也沒有偵測結果時 EmptyState「尚未安排任何 worktree」+ 主要鈕「新增安排」；篩選後無結果 EmptyState「沒有符合此狀態的 worktree」+「顯示全部」。

### 3.3 安排對話框（新增 / 編輯 / 登記）

Dialog `md`，標題「新增 worktree 安排」／「編輯 worktree 安排」。由「登記」開啟時帶入該列的 repo、分支、路徑。

| 欄位 | 元件 | 規則 |
|---|---|---|
| Repo | Select | 必填；預設為目前選取的 repo |
| 分支 | Input（mono） | 必填；placeholder `feat/…` |
| 路徑 | Input（mono） | 必填；說明「相對於 repo 或絕對路徑」；同 repo 內重複時欄位錯誤「此路徑已有安排」 |
| 負責人 | Select（選項帶 Avatar，含「未指派」） | 選填 |
| 關聯任務 | Select（可搜尋，選項為 `#id 標題`） | 選填 |
| 用途 | Textarea（3 行） | 選填，上限 200 字，右下計數 |

- 動作列：「取消」secondary、「儲存」primary（必填未齊時停用，送出中 loading）。API 錯誤顯示於表單上方 danger-soft 提示列，不關閉對話框。
- 刪除：確認 Dialog `sm`，標題「刪除此安排？」，內文「只會移除安排紀錄，不會變更磁碟上的 worktree 或分支。」，主要鈕 `danger`「刪除」。
- 儲存 / 刪除成功後關閉並重抓列表（toast 於 T9 統一加入，本軌道不依賴）。

## 4. Repo 選擇與管理

- Repo Select 置於分頁列右側 `actions` 位置，選項為 repo 名稱 + `remote_slug`（text-tertiary）。只有一個 repo 時以 readonly 外觀顯示。
- 沒有任何 repo：整頁 EmptyState「尚未登記任何 repo」；管理員另有主要鈕「管理 repo」，一般成員的說明為「請管理員新增要追蹤的 repo」。
- 「管理 repo」（僅管理員）：Dialog `md`，列出名稱、本機路徑（mono）、遠端（`owner/name`），每列有 `<UpdatedAt>`；可新增 / 編輯 / 刪除，表單為三個 Input。
- **待協調者確認**：PLAN 1.4 的 repo 端點只列 `GET /api/eng/repos`。若後端不提供寫入，此對話框降為唯讀清單，底部以 `--text-xs` text-tertiary 註明「repo 由管理員在伺服器端設定」。

## 5. 互動與鍵盤

- `Tab` 順序：分頁列 → Repo Select → 工具列 → 表格列內的連結與動作。`R`：目前分頁重新整理（Issues 觸發同步；Worktrees 重新偵測）；focus 在輸入框時不觸發。
- `Enter`：focus 在 issue 標題時新分頁開啟；focus 在關聯任務時開啟 TaskDrawer。`Esc` 依 core §8 順序關閉選單 / 對話框 / 抽屜。
- 使用語意化 `<table>`，欄標題 `scope="col"`；Badge 以文字為可讀內容，色點 `aria-hidden`。重新整理完成後以 `aria-live="polite"` 唸出「已更新，共 N 筆」。
- 30 秒輪詢與視窗 focus 重抓只更新 Worktrees 列表與 Issues **快取**內容，不自動向來源端觸發同步。

## 6. 響應式

| 寬度 | 調整 |
|---|---|
| ≥ 1280px | 如線框，全部欄位顯示 |
| 1024–1279px | Worktrees 隱藏「關聯任務」欄（改為 `⋯` 選單第一項「開啟關聯任務」）；Issues 標籤最多顯示 2 個 |
| 768–1023px | Repo Select 與「管理 repo」換到分頁列下方獨立一列；負責人只留 Avatar；篩選 chips 可水平捲動；表格在卡片內水平捲動，不撐破 shell；對話框寬 `min(520px, 100vw - 32px)` |

實作檢查：每列都有 `<UpdatedAt>`；六種標示皆有文字 + 色點並可用 chip 篩選；未設定 token 是「說明狀態」而非錯誤；分頁 / repo / 篩選由 URL 驅動；無寫死色碼。

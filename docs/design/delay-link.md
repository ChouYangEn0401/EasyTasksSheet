# 設計規格 — feat/delay-link（任務依賴與延遲鏈）

> 目的：讓大家看見「哪件事要先做完，才能做哪個任務」，以及依賴帶來的預計延後。
> 這是幫忙**安排與互相支援**的工具，不是追究誰拖到誰（見 [product-principles.md](../product-principles.md)）。

## 1. 範圍

- 任務之間的**阻擋關係**（前置任務 → 等待中的任務），目前只支援 finish-to-start（前置完成後才能開始），可設 `lag`（完成後至少再等幾天）。
- 任務詳情新增「依賴」區；看板與清單標示「等待中」與預計延後；新增分頁「延遲鏈」（`/tasks/delay-link`，位於甘特圖後面）。
- 匯出 / 匯入（JSON）包含依賴；多台電腦同步（sync-push）**暫不**同步依賴。

## 2. 資料（migration `0015_task_dependencies.sql`）

| 欄位 | 說明 |
| --- | --- |
| `id`、`uid` | uid 由 AFTER INSERT trigger 補上（同 0005 作法），匯出入對應用 |
| `blocker_task_id` | 前置任務（需先完成）；FK tasks ON DELETE CASCADE |
| `blocked_task_id` | 等待中的任務；FK tasks ON DELETE CASCADE |
| `type` | 目前只有 `finish_to_start` |
| `lag_days` | 前置完成後至少再等幾天（0–365，預設 0） |
| `note`、`created_by`、`created_at`、`updated_at` | |

約束：`UNIQUE(blocker, blocked)`、`CHECK(blocker <> blocked)`；兩端皆有索引。獨立資料表，不依賴「相關任務」（feat/task-relations）。

## 3. 規則

- **禁止循環**：建立前以 DFS 檢查（既有邊中若 blocked 可走到 blocker 即成環），成環回 `409 DEPENDENCY_CYCLE`，
  訊息列出環上的任務標題：「無法建立：「C」 → 「A」 → 「B」 → 「C」 會形成循環」，`details.cycle` 為 `{id,title}` 陣列。
- **已完成**（所屬狀態 category = done）或**軟刪除**的任務**不再擋人**；紀錄保留。延遲鏈可勾選「顯示已完成的前置任務」以淡色顯示。
- 允許跨專案。
- 同一對任務重複建立為冪等（回 200 與既有那筆）；自己擋自己 400；任務不存在 404。
- 讀取登入即可；寫入需 `tasks.edit`（既有 `/api/tasks*` 寫入守門涵蓋，見 [permissions.md](../permissions.md)）。
- 每次寫入在兩端任務各記一筆 `task update` 變更流水並更新兩端 `updated_at / updated_by`，看板與他人畫面經 SSE 即時更新。

## 4. 延遲推算（`server/app/dependency_calc.py`，純函式）

「今天」為台北時區日期（可注入）。只看**有效邊**（兩端皆未完成、未刪除），依拓撲序沿鏈傳遞：

1. 沒有未完成前置任務的任務：預計完成 = max(到期日（無則開始日）, 今天)。已逾期者以今天計（不可能在過去完成）。兩者皆無 → 無法推算。
2. 被擋住的任務：`bound = max(前置的預計完成 + 1 + lag)`
   - 預計開始 = max(開始日, bound)（無開始日則為 bound）
   - 有開始日與到期日 → 預計完成 = 預計開始 + 原本的持續天數
   - 只有到期日 → 預計完成 = max(到期日, bound)
   - 都沒有 → 預計完成 = 預計開始
3. 任一前置任務無法推算（沒有任何日期）→ `unknownBlockerDate = true`，本身也無法推算，介面顯示「等待中（對方尚未排程）」，不顯示延後天數。
4. `delayDays = max(0, 預計完成 − 原到期日)`；無到期日 → null。
5. `depth`：最長前置路徑長度（延遲鏈分欄用）。
6. 最長延遲路徑（`criticalPath`）：從「預計最晚完成」（同日比延後天數、再比層數）的任務，沿「決定其開始日的前置任務」回溯到起點。

**範例**（今天 01-05）：A 到期 01-10；B 01-08~01-09（2 天）等 A；C 只有到期 01-12，等 B。

| 任務 | bound | 預計開始 | 預計完成 | 延後 |
| --- | --- | --- | --- | --- |
| A | — | — | 01-10 | 0 |
| B | 01-11 | 01-11 | 01-12 | 3 天 |
| C | 01-13 | 01-13 | 01-13 | 1 天 |

若 A 已逾期（到期 01-01）→ A 以今天 01-05 計，後續依序推算。A 標為完成後 B 不再被擋，B 依自己的日期計算。

## 5. API

| 端點 | 說明 |
| --- | --- |
| `GET /api/tasks` | 每筆**加入** `isBlocked`、`blockedByCount`、`blocksCount`、`delayDays`、`projectedEnd`（單次批次推算，無 N+1；不在任何依賴中的任務為 false / 0 / null） |
| `GET /api/tasks/:id/dependencies` | `{ blockedBy: [...], blocks: [...], self }`；每筆含依賴 id、lagDays、note、對方任務精簡資訊（`task`）與其延後資訊（`projection`）。軟刪除的對方不列出 |
| `POST /api/tasks/:id/dependencies` | `{ direction: 'blocked_by' \| 'blocks', targetId, lagDays?, note? }`；201 新建 / 200 已存在；回傳該筆（含 `direction`、`self`） |
| `PATCH /api/tasks/:id/dependencies/:depId` | `{ lagDays?, note? }` |
| `DELETE /api/tasks/:id/dependencies/:depId` | 回傳 `removed`（direction、targetId、lagDays、note），前端「復原」以 POST 重建 |
| `GET /api/tasks/delay-chains?project=&assignee=&status=&q=&includeDone=` | 依賴圖的連通元件（鏈）：`nodes`（任務資訊、預計開始 / 完成、delayDays、depth、isDone、blockerIds、criticalDelay）、`edges`（from→to、lagDays、active、critical）、`summary`（nodeCount、maxDelayDays、finalProjectedEnd、criticalPath、startNodes、doneCount）。**任一節點符合篩選則整條鏈顯示**；排序：最長延後由大到小，再依節點數 |

`/api/tasks/delay-chains` 的 router 掛在 `tasks.router` 之前，避免被 `/{id}` 攔截。

## 6. 介面

### 6.1 語氣與顏色

- 用「等待中」「前置任務」「完成後可開始」「預計延後」「對方尚未排程」「準時」；不出現「卡住」「拖延」「誰造成」等字眼，不排名。
- 被擋住用**琥珀色**（`--color-warning*` token）；準時用綠（success）；未排程用中性灰；**不使用紅色**。
- 「擋住 N」為中性灰小徽章，Tooltip「完成後，有 N 個任務可以開始」。

### 6.2 任務詳情「依賴」區（`DependenciesSection.tsx`）

- 本任務被擋住時頂部琥珀提示：「等待中 · 依前置任務的時程，預計延後 N 天（到 12/20）」。
- 兩小節：「等待這些任務完成」與「完成後可開始的任務」；每列：狀態點、標題（點擊切換到該任務）、負責人、日期、延後說明、lag。已完成的前置任務淡色＋刪除線並標「已完成的前置任務」。
- 「＋ 新增」開輕量搜尋選單：方向切換、標題關鍵字、排除自己與已存在者、最多 8 筆、↑↓ Enter 選擇；「進階」摺疊可設 lag 天數。循環等錯誤在選單內以琥珀提示顯示。
- 移除一鍵，toast 附「復原」。沒有 `tasks.edit` 時不顯示新增 / 移除。

### 6.3 看板與清單（最小接入，`DependencyBadge.tsx`、`dependency.css`）

- 被擋住的卡片：琥珀左側色條＋淡琥珀底、標題前鎖頭、底部徽章「等待中 · 預計延後 N 天 → 12/20」（無法推算或未延後時只寫「等待中」），Tooltip 說明。
- 正在擋住別人：「擋住 N」。與逾期、待辦清單、相關任務等徽章並存於卡片底部（自動換行，不擠壓標題）。
- 看板右上「顯示依賴標示」開關（預設開，`localStorage: ts.kanban.showDeps`）。
- 清單：標題旁小鎖頭與 Tooltip。

### 6.4 延遲鏈分頁（`DelayLinkPage.tsx`、`delayLinkLayout.ts`）

- 沿用任務區 layout 與 FilterBar（專案 / 負責人 / 狀態 / 關鍵字）；ViewTabs 右側「顯示已完成的前置任務」。
- 頂部中性摘要「共 N 條依賴鏈・最長預計延後 M 天」（皆可如期時「目前都可如期」）。
- 每條鏈一張卡片：標題「從「X」開始的依賴鏈」、說明「N 個任務・預計 12/20 全部完成・最多延後 M 天」。
- 由左到右分層圖：depth 分欄；節點顯示標題、負責人頭像、狀態、原定 / 預計完成日、徽章（琥珀「+3 天」、綠「準時」、灰「待排程」）；目前可立即開始的起點標「可立即開始」。
- SVG 箭頭由前置指向等待中的任務並標 lag；相鄰欄為曲線，跨欄的邊走列與列之間的通道（避免穿過節點）。
- 最長延遲路徑：琥珀粗框與粗箭頭，說明「強調的路徑決定了最終完成日」。
- 互動：點擊開詳情；hover / focus 高亮上下游、其餘淡化；鍵盤 roving tabindex，←→ 沿箭頭移動、↑↓ 同欄移動、Home / End、Enter 開啟。
- ≤768px 改為由上而下堆疊（縮排表示層級，並寫出「等待：…」）。
- 空狀態：「目前沒有依賴關係。在任務詳情的「依賴」加入前置任務，就能在這裡看到整條鏈」；篩選無結果顯示「清除篩選」。
- 大鏈（>50 節點）：排版為純函式並以 useMemo 快取，SVG 單次繪製。

## 7. 匯出 / 匯入

- 匯出檔新增 `taskDependencies`（以兩端任務 uid 表示）；舊匯出檔沒有此欄位仍可匯入。
- 匯入在任務之後套用：同 uid 或同一對任務視為同一筆（冪等）；衝突依全域策略；**會形成循環或任務不存在時略過**，原因列在結果的 `dependencyIssues`。取代模式下既有依賴隨任務刪除（cascade）。
- 依賴不在 `SPECS` 內，因此 sync-push 不會同步。

## 8. 已知限制

- 多台電腦同步（sync-push）不同步依賴。
- 甘特圖尚未畫依賴箭頭。
- 只支援 finish-to-start；沒有 start-to-start 等其他類型。
- 推算以日曆天計，不排除週末與假日；沒有到期日的任務只能推出預計日、無法計算延後天數。

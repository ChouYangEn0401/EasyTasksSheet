# 復原 / 重做（feat/undo）

全站 `Ctrl+Z` 復原、`Ctrl+Shift+Z`（或 `Ctrl+Y`）重做；Mac 用 `Cmd`。頂欄有「復原」「重做」圖示按鈕。

## 1. 行為規則

### 堆疊
- 兩個堆疊（undo / redo），各上限 **50** 筆，超過時捨棄最舊的。
- 新動作會**清空 redo**。
- 復原 / 重做為非同步：暫時性失敗（網路、5xx、401 / 408 / 429）**不推進堆疊**（可重試），顯示錯誤 toast「無法復原：…」；永久性失敗（其他 4xx，例如描述已被管理者鎖定）**移除該筆**並提示「無法復原，已從復原紀錄移除：…」，避免堆疊卡死、更早的動作無法復原。
- 執行中（含衝突對話框開著時）忽略重複按鍵；期間完成的**其他寫入照常登記**（不與執行中的那筆合併，且會清空重做）。復原本身的寫入不經登記路徑（直接呼叫 api 或 `undo: false`），不會被再記一次。
- **純記憶體**：重新整理頁面即清空；登出 / session 逾時時清空（`lib/auth.ts` endSession）。
- **只記錄自己的操作**：登記點在本機的 mutation 成功回呼；他人經 SSE 傳來的變更只會重抓資料，不會入堆疊。

### 合併
- 同一任務、同一組欄位在 **1.5 秒內**的連續編輯合併成一筆（保留最早的前值、最新的後值）。
- 同一次拖曳放下送出的多筆 PATCH（看板：狀態 + 排序，含鄰近卡片的重新編號）以 `undo.group` 合併成一筆，不限時間。
- 已被復原 / 重做過的項目不再與新動作合併。
- 合併後前後值相同（1.5 秒內把欄位改過去又改回來、待辦勾選又取消）→ 該筆移出堆疊，不留下「空的」復原。

### 衝突保護（任務）
- 復原 / 重做前先 `GET /api/tasks/:id` 取最新資料，對「這次動作會動到的欄位」比對：
  - 復原：目前值應等於動作當時**寫入的值**；重做：目前值應等於動作**之前的值**。
  - 不符＝別人之後又改過 → 對話框「「標題」已被別人修改 — 這個欄位在你修改之後被別人改過（現在是『X』）。仍要復原並覆蓋嗎？」〔略過這項〕〔仍要復原〕。略過 = 不寫入，並把這筆從堆疊移除；Esc 同略過。
  - 排序值（`sortOrder`）不比對：任何人的拖曳都會重新編號，比對只會誤報。
- 任務已被別人刪除（404）→ toast「此任務已不存在」，並把這筆從堆疊移除。

### 快捷鍵與焦點
- 焦點在可編輯元素（`input` 文字類、`textarea`、`select`、`contenteditable`）時**完全不攔截**，保留瀏覽器原生的文字復原。
- 開著對話框（`dialog[open]`）或拖曳進行中（`suspendGlobalShortcuts()`）時不觸發。任務抽屜不是對話框，開著時仍可用。
- 沒有可復原 / 重做的項目時什麼都不做，也不 `preventDefault`。
- 判斷為純函式 `resolveUndoShortcut()`（`lib/shortcuts.ts`），由 `shell/useGlobalShortcuts.ts` 掛載。

### 畫面
- 頂欄（`features/undo/UndoButtons.tsx`）兩個圖示按鈕，無項目時停用；Tooltip 與 aria-label 顯示下一步，例如「復原：把『X』移到『進行中』（Ctrl+Z）」。所有寬度都只顯示圖示。
- 執行後 toast「已復原：…」附「重做」鈕（5 秒）；重做則「已重做：…」附「復原」。toast 本身為 `role=status`（aria-live）。
- 文案用『』包住名稱、截斷 20 字：「修改『X』的標題」「修改『X』的 3 個欄位」「調整『X』的順序」「把『X』移到『進行中』」「建立任務『X』」「刪除任務『X』」。

## 2. 已接入的操作

| 操作 | 復原 | 重做 | 登記位置 |
| --- | --- | --- | --- |
| 任務欄位更新（清單就地編輯、抽屜、甘特拖曳 / 日期、改專案、自訂欄位逐鍵） | PATCH 回前值（只含這次改動的欄位） | 再 PATCH 新值 | `lib/hooks.ts` useUpdateTask、`features/tasks/data.ts` useOptimisticUpdate |
| 看板拖曳（狀態 + 排序，一次放下 = 一筆） | 同上 | 同上 | KanbanBoard 帶 `undo: { group, label, before }` |
| 建立任務（QuickAdd、useCreateTask） | 軟刪除 | `POST /api/tasks/:id/restore`（內容原封不動） | data.ts useOptimisticCreate、hooks.ts |
| 刪除任務（抽屜、useDeleteTask） | restore | 再軟刪除 | data.ts useDeleteTaskOptimistic、hooks.ts |
| 個人待辦：新增 / 欄位與狀態變更 / 刪除 | 刪除 / PATCH 回前值 / 以相同內容重建並放回原位置 | 反向 | `features/personal/api.ts` → `features/undo/simpleUndo.ts` |
| 問題回饋：新增 | 刪除 | 以相同內容重新建立 | `features/feedback/api.ts` → simpleUndo.ts |

- 個人待辦與問題回饋後端為**硬刪除**，重建後會是新的 id（以閉包追蹤最新 id），建立時間也會是新的。這兩者不做衝突檢查（個人待辦只有本人能改）。
- **尚未接入（後續軌道）**：問題回饋的修改 / 刪除（硬刪除，重建會遺失回報者與建立時間）、個人待辦的「清除已完成」與標記、待辦清單（checklist）、相關任務、阻擋 / 依賴關係、自訂欄位定義、狀態 / 專案管理、工程追蹤。

## 3. 如何讓新功能支援復原

1. **任務欄位的寫入**：直接用 `useUpdateTask()`（或 data.ts 的 `useOptimisticUpdate()`）即自動支援，不需額外程式。
   - 若呼叫端在 mutate **之前**已先樂觀改寫快取，必須帶 `undo: { before }`（動作前的值），否則讀到的前值會是新值。
   - 一次操作送出多筆 PATCH（例如清單拖曳排序）：以 `newUndoGroup()` 產生群組鍵，每筆都帶相同的 `undo: { group, label }`。
   - 不想入堆疊（背景自動更新、拖曳過程的暫存）：帶 `undo: false`。
2. **其他資料**：在寫入**成功之後**呼叫 `registerUndoable({ label, undo, redo })`（`lib/undo.ts`；元件內可用 `useUndoable()`）。
   - `undo` / `redo` 回傳 promise；丟出暫時性錯誤 = 失敗不推進；丟出永久性錯誤（`isPermanentUndoError`：401 / 408 / 429 以外的 4xx）或回傳 `'drop'` = 這筆已無法套用，從堆疊移除。
   - `undo` / `redo` 內的寫入請**直接呼叫 api**，或用 `undo: false` 的 hook，避免再被登記（執行期間的登記不再一律忽略）。
   - 連續的同類編輯可帶 `mergeKey`（預設 1.5 秒內合併）；需要自訂合併時提供 `merge(older)`，合併後回到原值時回傳 `noop: true`。
   - `registerUndoable()` 回傳項目 id；toast 上的「復原」請用 `performUndoEntry(id)`（不要比對標籤字串或直接呼叫 `undo()`）。
   - 有「他人可能同時修改」的資料，建議比照 `lib/taskUndo.ts` 先取最新資料再比對（`findConflicts`），衝突時用 `askConflict()` 詢問。
3. 文案用中文動詞開頭、名稱以『』包住（`quote()`），例如「勾選『X』」「刪除相關任務『X』」。

## 4. 相關檔案
- `src/web/lib/undo.ts`：UndoManager（純邏輯）、單例、`useUndoState`、`registerUndoable`、`performUndo`。
- `src/web/lib/taskUndoModel.ts`：欄位攤平、衝突判斷、合併、文案（純函式）。
- `src/web/lib/taskUndo.ts`：任務的登記、以 mutation 執行復原（樂觀更新 + 失敗回復）、衝突對話框的 promise。
- `src/web/features/undo/`：頂欄按鈕、衝突對話框、個人待辦 / 回饋的登記。
- `src/web/features/undo/linkUndo.ts`：相關任務、依賴（新增 / 移除）與待辦清單（新增、勾選、刪除項目）的登記；抽屜 / 甘特 toast 的「復原」以登記時回傳的項目 id 執行（`undoFromToast()` / `performUndoEntry(id)` → `undoManager.undoEntry(id)`）：在堆疊頂端時走一般復原（之後可重做）；不在頂端則執行後**從堆疊移除**（之後 Ctrl+Z 不會再執行一次），錯誤照常提示；已復原過則不做事。「清除已完成」不提供復原（確認對話框已說明）。
- 後端：`POST /api/tasks/:id/restore`（`server/app/features/tasks.py`；需 `tasks.edit`；未刪除時冪等回傳；不存在 404；寫入 `create` 變更流水讓其他人看到任務重新出現）。
- 測試：`src/web/lib/undo.test.ts`、`taskUndoModel.test.ts`、`shortcuts.test.ts`、`server/tests/test_tasks.py`（restore）、`tests/e2e/undo.spec.ts`。

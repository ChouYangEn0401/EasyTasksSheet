# 資料同步（feat/sync-push）介面規格

使用說明與規則見 [docs/sync.md](../sync.md)。

## 頁面

- 路徑 `/admin/data/sync`，導覽「資料同步」（位於「資料管理」下方，圖示 refresh）；具 `sync.manage` 或 `sync.resolve` 任一即顯示。兩者皆無 → 「沒有權限」空狀態。
- 頁籤（`role=tablist`，左右方向鍵切換，`?tab=conflicts` 可直接開啟）：
  - 「同步來源」：需 `sync.manage`。
  - 「待確認衝突」：需 `sync.resolve`；有待處理時頁籤顯示數量徽章（warning）。

### 同步來源

- 標題列：「同步來源」＋一句說明（只會新增與更新，不會因為資料不見而刪除）＋主要按鈕「新增同步來源」。
- 表格欄位：名稱（下方小字：金鑰末碼、是否自動建立缺少的成員）、最後同步（相對時間，hover / focus Tooltip 顯示絕對時間）、最後一次摘要（新增 / 更新 / 相同 / 衝突 / 略過；下方：電腦名稱 · 全量 / 增量 · 待確認 N）、狀態徽章（啟用中 / 已停用）、⋯ 選單（停用 / 重新啟用、開關自動建立缺少的成員、重新產生金鑰…、刪除來源…）。
- 狀態：載入骨架、錯誤（可重試）、空狀態「還沒有同步來源」。
- 新增對話框：名稱（必填，≤100）、「自動建立中央缺少的成員」勾選（預設關）。
- 一次性金鑰對話框（alertdialog，Esc / 點遮罩不關閉，只能按 ✕ 或「我已妥善保存」）：警告「金鑰只會顯示這一次」、金鑰（可複製）、完整命令 `python -m server.cli sync-push --server <目前網址> --token <金鑰>`（可複製）、`--dry-run` / `--full` 提示。
- 重新產生 / 刪除皆需確認對話框（說明舊金鑰立即失效；刪除不影響已上傳資料，衝突紀錄保留）。

### 待確認衝突

- 說明文字：「這些資料在兩邊幾乎同時被修改，系統不會自行決定，請確認要保留哪一份。」
- 切換：「待處理（N）」/「已處理紀錄」。
- 表格：勾選框（含全選）、資料（分類徽章＋標題；下方列出不同的欄位）、來源（已刪除的來源以灰字標示）、更新時間（中央 / 上傳兩行＋「差 N 分鐘」徽章）、「比較」按鈕。已處理紀錄另有「處理」欄（保留中央 / 採用上傳 / 逐欄位合併；誰、何時；系統自動處理顯示「系統（之後的上傳已取代）」）。
- 多選時出現批次列：已選 N 筆、「全部保留中央」「全部採用上傳」（確認對話框）、「取消選取」。
- 並排比較（`?conflict=<id>`，瀏覽器返回可回清單）：
  - 標題列：分類＋標題、緩和的說明（「這筆資料兩邊幾乎同時被修改，請決定要保留哪一份…」）、來源與雙方更新時間（差 N 分鐘）。
  - 「全部保留中央」「全部採用上傳」快捷鍵。
  - 表格三欄：欄位｜中央現有｜來源上傳；只列有差異的欄位；每列為一組 radio（原生 `<input type=radio>`，Tab / 方向鍵可操作），選取的一側以 accent 底框標示。參照欄位顯示名稱（專案、狀態、任務標題），成員顯示「名稱（@帳號）」，優先度顯示中文。
  - 底部：目前決定的摘要（將保留中央 / 將全部採用上傳 / 將採用上傳的 N 個欄位）＋「套用決定」。成功後回到清單並顯示成功訊息。
- 768px：表格可水平捲動、比較表欄位欄縮窄、金鑰與命令換行。

## API

全部回應為 JSON；錯誤格式同其他 API（`{"error": {"code", "message", "details"?}}`）。

### `POST /api/sync/push`（公開路徑，金鑰驗證）

- 標頭：`Authorization: Bearer <金鑰>` 或 `X-Sync-Token: <金鑰>`；`Content-Type: application/json`。
- body：匯出檔格式（`format: "tasks-sheets-export"`、`schemaVersion: 1`、`exportedAt`、`users`、各類別陣列），另加
  `source: {machineName, exportedAt, since, pushId?}`、`incremental: bool`、`batch: {index, total}`。參照（`projectUid` 等）可指向中央既有資料，不要求在同一批。
- 200：`{source: {name}, batch, categories: [{key, label, created, updated, unchanged, conflict, skipped, older}], totals, pendingConflicts, skipped: [原因], missingUsers: [帳號], createdUsers: [帳號], backupFile}`
- 400 `SYNC_INVALID`（格式 / 驗證失敗，details 為問題清單）、403 `FORBIDDEN`（金鑰無效 / 停用 / 不存在）、413 `PAYLOAD_TOO_LARGE`、429 `TOO_MANY_REQUESTS`、500 `BACKUP_FAILED`。

### 同步來源（`sync.manage`）

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/admin/sync/sources` | `{sources: SyncSource[]}`（不含金鑰） |
| POST | `/api/admin/sync/sources` | `{name, autoCreateUsers?}` → 201 `{source, token}`（金鑰只在此出現） |
| PATCH | `/api/admin/sync/sources/:id` | `{name?, isActive?, autoCreateUsers?}` → `{source}` |
| POST | `/api/admin/sync/sources/:id/token` | 重新產生金鑰 → `{source, token}` |
| DELETE | `/api/admin/sync/sources/:id` | 刪除來源（金鑰失效；衝突紀錄保留，`sourceId` 變為 null） |

`SyncSource`：`id, name, tokenHint, autoCreateUsers, isActive, createdBy, createdAt, updatedAt, lastPushAt, lastPushSummary, pendingConflicts`（型別見 `src/shared/syncPush.ts`）。

### 衝突（`sync.resolve`）

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/api/admin/sync/conflicts?status=pending\|resolved` | `{conflicts, counts: {pending, resolved}}`（最多 500 筆） |
| GET | `/api/admin/sync/conflicts/:id` | 詳細：`fields: [{name, label, local, incoming, localDisplay, incomingDisplay}]`（待處理時以中央**目前**資料比較） |
| POST | `/api/admin/sync/conflicts/:id/resolve` | `{resolution: keep_local\|use_incoming\|merged, choices?: {欄位: local\|incoming}}`；已解決 → 409 `ALREADY_RESOLVED`；回傳最新詳細 |
| POST | `/api/admin/sync/conflicts/resolve-bulk` | `{ids: number[], resolution: keep_local\|use_incoming}` → `{resolved, skipped}`（單一 transaction） |

## 資料表（migration 0012）

- `sync_sources`：`id, uid, name, token_hash(unique), token_hint, auto_create_users, is_active, created_by, created_at, updated_at, last_push_at, last_push_summary(JSON), last_backup_at`
- `sync_conflicts`：`id, source_id(ON DELETE SET NULL), source_name, category, entity_uid, local_json, incoming_json, local_updated_at, incoming_updated_at, diff_fields(JSON), status(pending|resolved), resolution(keep_local|use_incoming|merged), merged_json, resolved_by, resolved_at, created_at, updated_at`；索引 `(status, created_at)`、`(source_id, category, entity_uid)`、待處理唯一 `(source_id, category, entity_uid) WHERE status='pending'`
- `sync_uid_aliases`：`(source_id, category, source_uid) → central_uid`（狀態 / 專案名稱對應）

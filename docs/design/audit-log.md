# 稽核紀錄與還原（feat/audit-log）

> 情境：任務由 PM 派發後，描述不想被改壞；出事時要能查「是誰、何時、改了什麼」，並一鍵還原。

## 語氣與隱私原則

稽核是為了**還原失誤與追溯原因**，不是監控或評比個人（對照 `docs/product-principles.md`）。

- 頁首說明：「列出重要的改動與前後內容，用來回溯與還原，而非評比。」
- 摘要只描述事實（「把『X』的狀態從『待辦』改為『進行中』」），不加評價。
- **不提供**任何排名或「誰改最多」的統計；篩選只是為了找到某一筆。
- 差異高亮不用紅 / 綠：刪除為灰底刪除線、新增為 accent 淡底；還原衝突的提示用 accent 邊框，不用紅色。
- **不記錄**：個人待辦（私人資料）、密碼或臨時密碼的內容、登入 / 登出、在線狀態。

## 資料模型（migration `0018_audit_log`）

`audit_log` 與既有 `changes` 分開，`changes` 保持不動。

| 欄位 | 說明 |
| --- | --- |
| `id`、`ts`（ms） | 游標分頁用 id 由新到舊 |
| `actor_id`、`actor_name`、`actor_username` | 操作者與**當下**的顯示名稱 / 帳號快照（之後改名或停用仍可讀）；同步為 `actor_id = NULL`、`actor_name = 同步：<來源>` |
| `source` | `web` / `api` / `import` / `sync` / `system` / `revert` |
| `entity_type`、`entity_id`、`entity_uid`、`entity_label` | `task` / `project` / `status` / `property` / `user` / `permission` / `import` / `sync`；`entity_label` 是標題或名稱快照（刪除後仍可看） |
| `task_id` | 與任務相關時填入（任務活動歷史查詢；有索引） |
| `action` | `create` / `update` / `delete` / `restore` / `reorder` / `reset_password` / `unlock` / `apply` |
| `summary` | 中文一句話 |
| `before_json`、`after_json` | **只存有變動的欄位**（API 欄位名，自訂欄位為 `custom.<propertyId>`）；建立只有 after、刪除只有 before |
| `revertable`、`note` | 是否可還原；`note` 為不可還原的原因（例如「專案無法刪除；如不再使用，可改為封存」） |
| `reverted_by`、`reverted_at`、`revert_of` | 原筆被還原時標記；還原本身是一筆新紀錄，`revert_of` 指向原筆 |
| `request_id` | 預留 |

索引：`ts`、`actor_id`、`(entity_type, entity_id)`、`task_id`、`revert_of`。不設外鍵，被刪除的資料仍以快照可讀。

**大小**：單一欄位值超過 20,000 字元時截斷並記入 `__truncated__`（任務描述上限即 20,000 字，可完整保存）；修改前內容被截斷的紀錄自動標為不可還原。

**一致性**：稽核與主操作寫在**同一個 transaction**（`SAVEPOINT` 包住）；主操作回滾時稽核一起回滾。稽核寫入本身失敗只記警告（logger `server.audit`），不讓主操作失敗。

**保留期限**：`AUDIT_RETENTION_DAYS`（預設 365）。啟動時修剪一次，之後寫入稽核時每日至多檢查一次。

### 與 `changes` 表的差異

| | `changes` | `audit_log` |
| --- | --- | --- |
| 用途 | 即時同步（SSE）、總覽活動 | 回溯與還原 |
| 內容 | 誰動了哪一筆（無前後值） | 前後值、摘要、名稱快照 |
| 保留 | `CHANGES_RETENTION_DAYS`（30） | `AUDIT_RETENTION_DAYS`（365） |

即時更新沿用主操作本身的 `record_change`（維持「每次寫入恰好一筆流水」的既有不變式，不另寫 `entity = audit` 的流水）：前端收到 task / project / status / property / user / permission 的變更時，一併 invalidate `['audit']` 查詢（`src/web/lib/sync.ts`）。還原同樣對被還原的資料寫 `record_change`。

## 記錄範圍

集中介面：`server/app/audit.py`（`record_audit`、`diff_fields`、`snapshot`、`revert_action`、`plan_revert`、`prune_audit`）；各操作的摘要與前後值在 `server/app/audit_events.py`，呼叫點都在原本的 transaction 內、只加一行，不改既有回應格式。

| 操作 | 記錄 | 可還原 |
| --- | --- | --- |
| 任務建立 / 軟刪除 | 非空欄位快照 | ✓（建立 → 軟刪除；刪除 → 還原） |
| 任務更新 | 有變動的欄位（標題、專案、描述、狀態、負責人、優先度、日期、估時、進度、自訂欄位逐鍵） | ✓（含衝突保護） |
| 任務只改順序 | 「調整了『X』的順序」，同一人 10 分鐘內連續調整合併為一筆；順序隨其他欄位一起變（看板拖曳）時只記其他欄位 | ✓ |
| 專案建立 | | ✗（專案無法刪除，可封存） |
| 專案改名 / 改色 / 封存 / 排序 | | ✓ |
| 狀態新增 / 改名 / 改色 / 類別 / 排序 / 刪除 | | ✓（新增 → 刪除：已有任務使用時不可；刪除 → 以原編號重建） |
| 狀態「改移並刪除」 | 一筆狀態摘要＋每筆被改移任務一筆（出現在任務活動歷史） | ✗ |
| 自訂欄位定義新增 / 修改 / 刪除 | | ✓（刪除 → 以原編號重建，任務上的值仍在） |
| 成員新增 | 帳號、顯示名稱、角色 | ✗（帳號無法刪除，可停用） |
| 成員停用 / 啟用 / 角色 / 顯示名稱 | | ✓（不可讓系統沒有啟用中的 root；涉及 root 需 `roles.assign_root`；還原為停用時撤銷 session） |
| 成員重設密碼 / 解除鎖定 | 只記事件，不存密碼 | ✗ |
| 個人設定帳號 / 顯示名稱 | | ✗（需由本人修改） |
| 權限設定變更 / 還原預設 | 前後矩陣差異（`role:capability`） | ✓（還原為前一版；需 `permissions.configure`，即 root） |
| 資料匯入套用 | 一筆摘要（新增 / 更新 / 刪除筆數） | ✗（請用匯入前自動備份） |
| 同步上傳套用 | 一筆摘要；沒有新增 / 更新 / 待確認時不記 | ✗（請用同步前自動備份） |

不記錄：個人待辦、問題回饋、工程追蹤、附件、登入、系統事件。

## 還原規則

`POST /api/admin/audit/:id/revert` `{"force"?: boolean}`，全部在單一 transaction：

1. 已還原過 → 409 `ALREADY_REVERTED`；不可還原或目前條件不允許 → 409 `NOT_REVERTABLE`（訊息即原因）。
2. 需 `audit.revert`，且具備該項目原本的管理權限（任務 `tasks.edit`、專案 `projects.manage`、狀態 `statuses.manage`、自訂欄位 `properties.edit`、成員 `members.manage`、權限 `permissions.configure`）。
3. **欄位更新**：把有變動的欄位設回 before。若某欄位目前值 ≠ 該次的 after（之後又被改過）→ 409 `REVERT_CONFLICT`，`details.conflicts` 列出欄位、目前值、該次 after、要還原成的 before；帶 `force: true` 才覆蓋。
4. 任務更新但任務目前已刪除 → 需先還原刪除。原本的狀態 / 專案 / 負責人已不存在 → 不可還原。
5. 成功後：寫一筆新紀錄（`source = revert`、`revert_of = 原 id`、摘要「還原：…」，本身也可再還原），標記原筆 `reverted_by / reverted_at`，並對資料寫 `record_change`。

`GET /api/admin/audit/:id` 另回 `revertPreview`（`kind`、要還原的欄位含目前值與 `conflict`、`blocked` 原因），還原對話框據此顯示。

## API

| 端點 | 權限 | 說明 |
| --- | --- | --- |
| `GET /api/admin/audit?from=&to=&actor=&entityType=&action=&taskId=&q=&revertable=&limit=&before=` | `audit.view` | 游標分頁（`before` = 上一頁的 `nextBefore`）；`q` 搜尋摘要與名稱；`revertable=true` 只列可還原且未還原者 |
| `GET /api/admin/audit/:id` | `audit.view` | 完整前後值、`changes`（含中文欄位名與值）、`revertPreview` |
| `POST /api/admin/audit/:id/revert` | `audit.revert` | 見上 |
| `GET /api/tasks/:id/history?limit=&before=` | `audit.view_task_history` | 該任務的活動歷史（含已刪除任務） |

不提供修改或刪除稽核的 API；只依保留期限修剪。

## 前端

- **稽核紀錄頁** `/admin/audit`（導覽在「資料同步」之後、需 `audit.view`；`src/web/features/audit/AuditPage.tsx`）：
  - 篩選：時間快選（今天 / 7 天 / 30 天 / 全部 / 自訂日期）、操作者、類型、動作、可否還原、搜尋、任務 ID；條件寫在網址（可分享）。
  - 時間線：時間、操作者頭像＋名稱、摘要、類型 / 來源標籤、狀態（可還原 / 不可還原 / 已還原）。點列展開「修改前 / 修改後」，只列有差異的欄位；長文字以行內差異高亮（`inlineDiff`：先行比較，再把相鄰的刪除＋新增細分到詞 / 字）。
  - 有 `audit.revert` 者每列有「還原」：對話框列出欄位的「目前 / 還原後」；衝突欄位以 accent 底色與說明「在此之後又被修改過（現在是…）」，按鈕改為「仍要還原（覆蓋）」。成功 toast「已還原：…」，列轉為「已還原（由 XX 於 時間）」並可「查看還原紀錄」。
  - 捲到底自動載入（亦有「載入更多」按鈕）；768px 時時間與操作者併為一行、摘要在下。
- **任務活動歷史**（`TaskHistorySection.tsx`，TaskDrawer 最下方、預設收合）：誰、何時、摘要；長文字或多欄位可「查看差異」；有 `audit.revert` 者顯示「還原」；固定 `max-height: 320px` 的獨立捲動區（細捲軸 `.aud-scroll`）、「載入更早」。有 `audit.view` 者另有「在稽核紀錄查看」。

## 已知限制

- 留言、描述鎖定（feat/task-discussion）、待辦清單、相關任務、依賴等之後由協調者接入（呼叫 `record_audit` 即可）。
- 匯入與同步只記一筆摘要、不可逐筆還原；同步衝突的手動處理不記錄。
- 專案、成員建立不可還原（沒有刪除 API）；狀態「改移並刪除」不可還原。
- 個人待辦不記錄；保留 365 天後自動刪除。

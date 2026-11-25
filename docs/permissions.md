# 角色與權限

三層角色：**root > manager > user**。下表為**預設**矩陣；root 可在「權限設定」頁（`/admin/permissions`）調整 manager 與 user 的權限（見〈自訂權限〉）。

| 角色值    | 顯示名稱   | 定位                                                  |
| --------- | ---------- | ----------------------------------------------------- |
| `root`    | 超級管理員 | damageable-command：可造成不可逆影響的操作            |
| `manager` | 管理者     | danger-command：影響全體成員的設定與管理              |
| `user`    | 成員       | 日常協作                                              |

- 唯一來源：後端 `server/app/permissions.py`（`CAPABILITIES` 預設矩陣、`CAPABILITY_INFO` 中文名稱 / 說明 / 分組、`PROTECTED_CAPABILITIES`、`can(user, capability, db)`、FastAPI dependency `require(capability)`）；前端名稱表 `src/shared/permissions.ts`（pytest 比對兩邊一致）。
- 後端強制：不具權限一律 **403** `{"code": "FORBIDDEN", "message": "沒有權限執行此操作"}`。一律依**有效矩陣**（預設 + 覆寫）判斷。
- 前端只做顯示：`/api/auth/me` 與登入回應帶 `capabilities`（有效矩陣下的字串陣列），以 `useCan(capability)`（`src/web/lib/permissions.ts`）決定顯示 / 隱藏，不再以角色字串判斷。
- 顯示名稱表：`ROLE_LABELS`（`src/shared/users.ts`）。

## 預設矩陣

| capability              | 內容                                                         | user | manager | root |
| ----------------------- | ------------------------------------------------------------ | :--: | :-----: | :--: |
| `tasks.edit`            | 任務新增 / 編輯 / 軟刪除（全員可互改）                       |  ✓   |    ✓    |  ✓   |
| `feedback.edit`         | 問題回饋                                                     |  ✓   |    ✓    |  ✓   |
| `personal.edit`         | 個人清單                                                     |  ✓   |    ✓    |  ✓   |
| `eng.edit`              | 工程追蹤的問題與 worktree 紀錄（含 GitHub 同步 / 匯入 / 建立 issue、移到回收區 / 還原、確認或忽略可疑回報） |  ✓   |    ✓    |  ✓   |
| `eng.status.manage`     | 工程追蹤的問題 / 工作樹狀態：新增、改名、改色、排序、封存、刪除未使用的自訂狀態（「讓人自己建立」，預設全員） |  ✓   |    ✓    |  ✓   |
| `projects.create`       | 建立專案                                                     |  ✓   |    ✓    |  ✓   |
| `properties.edit`       | 自訂欄位（property）                                         |  ✓   |    ✓    |  ✓   |
| `profile.edit`          | 自己的個人資料與密碼                                         |  ✓   |    ✓    |  ✓   |
| `audit.view_task_history` | 任務詳情的「活動歷史」（看不到還原按鈕與全站稽核頁；docs/design/audit-log.md） |  ✓   |    ✓    |  ✓   |
| `comments.write`        | 任務討論區：留言、回覆、編輯 / 刪除自己的訊息、標記自己發起的討論串已解決（[task-discussion.md](design/task-discussion.md)） |  ✓   |    ✓    |  ✓   |
| `audit.view`            | 後台「稽核紀錄」頁：查看所有重要改動的前後內容               |      |    ✓    |  ✓   |
| `audit.revert`          | 從稽核紀錄還原改動（另需該項目原本的管理權限，例如還原權限設定需 `permissions.configure`） |      |    ✓    |  ✓   |
| `members.manage`        | 成員新增 / 停用 / 啟用 / 重設密碼 / 解鎖 / 編輯；角色限 user ↔ manager |      |    ✓    |  ✓   |
| `statuses.manage`       | 狀態新增 / 改名 / 改色 / 排序 / 刪除                         |      |    ✓    |  ✓   |
| `projects.manage`       | 專案改名 / 改色 / 排序 / 封存                                |      |    ✓    |  ✓   |
| `github.manage`         | GitHub 連動（專案 ↔ repo 設定）                              |      |    ✓    |  ✓   |
| `eng.scan`              | 掃描本機專案：在伺服器上掃描 `WORKTREE_SCAN_ROOTS` 內的資料夾並登記 worktree（大動作，先限管理者） |      |    ✓    |  ✓   |
| `eng.trash.purge`       | 永久清空工作樹回收區（唯一會真正刪除 worktree 紀錄的操作）    |      |    ✓    |  ✓   |
| `data.export_json`      | JSON 匯出                                                    |      |    ✓    |  ✓   |
| `data.import_merge`     | 匯入（合併模式的預覽與套用）                                 |      |    ✓    |  ✓   |
| `sync.manage`           | 多台電腦同步：建立 / 停用 / 重新產生金鑰 / 刪除同步來源（docs/sync.md） |      |    ✓    |  ✓   |
| `sync.resolve`          | 多台電腦同步：處理待確認衝突、檢視處理紀錄                   |      |    ✓    |  ✓   |
| `comments.moderate`     | 任務討論區：刪除他人的訊息、標記任何討論串已解決 / 重新開啟  |      |    ✓    |  ✓   |
| `tasks.lock`            | 鎖定 / 解鎖任務描述；鎖定後只有具此權限者可修改描述（其他成員改在討論區補充） |      |    ✓    |  ✓   |
| `data.backup_db` 🔒      | 完整資料庫 .db 備份下載（含密碼雜湊與 session）              |      |         |  ✓   |
| `data.import_replace` 🔒 | 匯入「取代全部」模式                                         |      |         |  ✓   |
| `roles.assign_root` 🔒   | 指派 / 撤銷 root；管理 root 帳號（編輯、停用、重設密碼、解鎖） |      |         |  ✓   |
| `permissions.configure` 🔒 | 權限設定（調整 manager / user 的權限）                     |      |         |  ✓   |

🔒 = 受保護項目（見下）。CLI（`python -m server.cli ...`，含 `restore`、`import --replace`）屬伺服器本機操作，不受此表限制。

## 自訂權限

root 在「權限設定」頁勾選 / 取消 manager 與 user 的各項權限，按「儲存」後立即生效；「還原為預設」移除所有自訂。

- **儲存方式**：`role_permissions` 表（migration `0010_role_permissions`）只存與預設不同的格子（`role`、`capability`、`allowed`、`updated_at`、`updated_by`）。沒有覆寫的格子採預設；改回預設值即刪除該列。之後版本新增的 capability 自動採預設，不需 migration；已移除的 capability 的覆寫列會被忽略。
- **API**（皆需 `permissions.configure`）：
  - `GET /api/admin/permissions`：每個 capability 的中文名稱、說明、分組、是否受保護、各角色預設值 / 有效值、是否已覆寫；以及最後修改時間與修改者。
  - `PUT /api/admin/permissions` `{"changes": [{"role": "user", "capability": "statuses.manage", "allowed": true}, ...]}`：批次設定（單一 transaction；任一筆不合法則全部不寫入，400）；回傳新矩陣。
  - `POST /api/admin/permissions/reset` `{"role"?: "manager" | "user"}`：還原為預設（省略 role = 全部）；回傳新矩陣。
- **即時更新**：每次寫入記一筆變更流水 `entity_type = permission`（`entity_id = 0`），既有 SSE 推送後，前端（`src/web/lib/sync.ts`）重抓 `/api/auth/me`，在線使用者的導覽與按鈕即時顯示 / 隱藏。
- **快取**：覆寫在記憶體中依資料庫快取，寫入後立即失效，下一個請求就套用新設定。系統為**單一 worker（單一行程）**；若日後改為多行程，需另行處理快取同步（例如每次請求檢查 changes 流水）。直接以 SQL 修改 `role_permissions` 需重新啟動服務才會生效。

### 保護規則

- **root 恆擁有全部權限**，不可被覆寫（API 拒絕 `role: "root"`；資料表 CHECK 只允許 manager / user），避免把自己鎖在外面。
- **受保護項目**（`roles.assign_root`、`data.backup_db`、`data.import_replace`、`permissions.configure`）只允許 root：API 拒絕授予（400「「X」僅限超級管理員，無法授予…」），即使資料表中有此類覆寫也會被忽略；前端勾選框鎖定並以鎖頭提示。
- **被要求改密碼的帳號**（`must_change_password`）即使沒有 `profile.edit` 仍可改密碼，避免無法完成首次登入。

### 限制與注意

- 自訂後不再保證「高層擁有低層的全部權限」：例如可以讓 user 有 `statuses.manage` 而 manager 沒有。邊界由 root 決定。
- 「列入總覽統計」（`inOverview`）屬成員欄位：需 `members.manage`，操作 root 帳號仍需 `roles.assign_root`；變更會寫入稽核紀錄（可還原）。匯出檔含此欄位；匯入（及 sync-push「自動建立缺少的成員」）只套用到**新建立**的帳號（缺漏時依角色預設），既有帳號不覆寫。
- 授予 user `members.manage` 等於允許成員新增成員並在 user ↔ manager 間調整角色（含把自己升為 manager）。
- 一般協作權限（`tasks.edit`、`comments.write`、`feedback.edit`、`personal.edit`、`eng.edit`、`projects.create`、`properties.edit`、`profile.edit`）只限制**寫入**（POST / PUT / PATCH / DELETE），讀取不受影響；由全域 middleware 依路徑檢查（`permissions.WRITE_GUARDS`）。前端目前未依這些權限隱藏編輯控制項，收回後操作時會顯示「沒有權限執行此操作」。
- 權限設定不在 JSON 匯出 / 匯入範圍內（完整 .db 備份會包含）。

## 端點對照

| 端點                                                           | 權限                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `/api/admin/users*`（含未知的 `/api/admin/*`）                 | `members.manage`；目標或新角色為 root 時另需 `roles.assign_root` |
| `GET / PUT /api/admin/permissions`、`POST /api/admin/permissions/reset` | `permissions.configure`                          |
| `GET /api/admin/data/export`                                   | `data.export_json`                                        |
| `POST /api/admin/data/import/preview`、`/import/apply`（merge） | `data.import_merge`                                       |
| `POST /api/admin/data/import/apply`（`mode: "replace"`）        | 另需 `data.import_replace`                                |
| `GET /api/admin/data/backup`                                   | `data.backup_db`                                          |
| `/api/admin/sync/sources*`                                     | `sync.manage`                                             |
| `/api/admin/sync/conflicts*`                                   | `sync.resolve`                                            |
| `POST /api/sync/push`                                          | 不需登入；以同步來源金鑰驗證（docs/sync.md）              |
| `GET /api/admin/audit`、`GET /api/admin/audit/:id`             | `audit.view`（只讀；不提供修改 / 刪除稽核的 API）          |
| `POST /api/admin/audit/:id/revert`                             | `audit.revert`，另需該項目的權限：任務 `tasks.edit`、專案 `projects.manage`、狀態 `statuses.manage`、自訂欄位 `properties.edit`、成員 `members.manage`（涉及 root 另需 `roles.assign_root`）、權限設定 `permissions.configure` |
| `GET /api/tasks/:id/history`                                   | `audit.view_task_history`                                 |
| `POST /api/projects`                                           | `projects.create`（預設 user 以上；root 可調整各層設定）  |
| `PATCH /api/projects/:id`                                      | `projects.manage`                                         |
| `POST / PATCH / DELETE /api/statuses`                          | `statuses.manage`；刪除時仍有任務（含已刪除任務）使用 → 409，且至少保留一個狀態 |
| `POST /api/statuses/:id/migrate-and-delete`                    | `statuses.manage`；body `{ targetStatusId }`，單一 transaction 把任務（含已刪除）改移到目標狀態後刪除，並為每筆任務寫入變更流水；仍至少保留一個狀態 |
| `GET /api/statuses/usage`                                      | 全員；各狀態被任務使用的筆數（管理狀態對話框用）          |
| `PUT /api/eng/github-links`                                    | `github.manage`                                           |
| 寫入 `/api/tasks*`（含 `/api/tasks/:id/checklist*` 待辦清單）  | `tasks.edit`（討論區 `/api/tasks/:id/comments*` 除外，見下） |
| `POST / DELETE /api/tasks/:id/relations*`、`POST /api/tasks/:id/duplicate` | 沿用 `tasks.edit`（同屬寫入 `/api/tasks*`，由寫入守門 middleware 檢查）；`GET /api/tasks/:id/relations` 登入即可 |
| `POST /api/tasks/:id/restore`                                  | `tasks.edit`（同上寫入守門）；還原軟刪除的任務（復原用），未刪除時冪等回傳、不存在 404 |
| `POST / PATCH / DELETE /api/tasks/:id/dependencies*`             | `tasks.edit`（沿用上一列的寫入守門）；讀取 `GET /api/tasks/:id/dependencies`、`GET /api/tasks/delay-chains` 登入即可（[design/delay-link.md](design/delay-link.md)） |
| `PATCH /api/tasks/:id` 或 `POST /api/tasks` 帶 `descriptionLocked` | 另需 `tasks.lock`                                     |
| `PATCH /api/tasks/:id` 修改已鎖定任務的 `description`（內容有變） | 另需 `tasks.lock`；否則 403「描述已由管理者鎖定，請把補充寫在討論區」 |
| `GET /api/tasks/:id/comments`、`/comments/:rootId/replies`     | 全員（登入即可）                                          |
| `POST /api/tasks/:id/comments`、`PATCH /comments/:cid`         | `comments.write`（寫入守門）；編輯只限作者本人            |
| `DELETE /api/tasks/:id/comments/:cid`                          | `comments.write`；刪除他人的訊息另需 `comments.moderate`  |
| `POST /api/tasks/:id/comments/:rootId/resolve`、`/unresolve`   | `comments.write`；且須為根訊息作者、任務負責人或具 `comments.moderate` |
| `POST /api/tasks/:id/comments/read`                            | 全員（只更新自己的已讀位置，不受寫入守門）                |
| 寫入 `/api/feedback*`                                          | `feedback.edit`                                           |
| 寫入 `/api/personal*`                                          | `personal.edit`                                           |
| 寫入 `/api/eng/issues*`、`/api/eng/worktree-records*`、`/api/eng/worktrees/pending/*`、`/api/eng/worktrees/paste*` | `eng.edit`（`paste` 為貼上 `git worktree list` 登記；對照 `WRITE_GUARDS`） |
| `POST / PATCH / DELETE /api/eng/statuses`                      | `eng.status.manage`；內建狀態不可刪除（可封存）、使用中的自訂狀態 → 409（只能封存）、每類至少保留一個未封存狀態 |
| `POST /api/eng/worktrees/scan`、`/scan/apply`                  | `eng.scan`；未設定 `WORKTREE_SCAN_ROOTS` → 409 `SCAN_DISABLED`；範圍外 → 400 |
| `POST /api/eng/worktree-records/trash/purge`                   | `eng.trash.purge`（另受 `eng.edit` 寫入守門）；body `{ "confirm": true }` |
| `POST /api/eng/worktrees/report`                               | 免登入，只以 `WORKTREE_REPORT_TOKEN` 驗證                  |
| 寫入 `/api/properties*`                                        | `properties.edit`                                         |
| `POST /api/auth/password`                                      | `profile.edit`（被要求改密碼時不檢查）                    |
| 其餘 API（含所有讀取）                                         | 全員（登入即可）                                          |

## 規則

- **前端一律走 capability**：入口以 `useCan('statuses.manage' / 'projects.create' / 'projects.manage')` 顯示或隱藏，後端以 `require(...)` 強制；不得以角色字串判斷。
- **預設專案不可刪除**：目前沒有刪除專案的 API，預設專案與其他專案一樣只能改名 / 改色 / 封存（`projects.manage`）；封存的專案預設不出現在下拉，可用「顯示已封存」切換。

- **最後一位 root**：不可停用或降級最後一位啟用中的 root（409「至少需保留一位超級管理員」）。
- **manager 管理成員**：可新增 user / manager、在 user ↔ manager 間調整（含其他 manager 與自己）；看得到 root 但不能操作。
- **預設管理員**：首次啟動自動建立的 `ADMIN_USERNAME` 帳號為 root。
- **舊資料**：migration `0006_roles` 將既有 `admin` → `root`、`member` → `user`；之後以舊值寫入會自動轉換，其他值拒絕。舊版匯出檔的 `role` 仍可匯入（匯入建立的成員一律為 user）。

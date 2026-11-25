# 角色與權限

三層角色，高層擁有低層的全部權限：**root > manager > user**。

| 角色值    | 顯示名稱   | 定位                                                  |
| --------- | ---------- | ----------------------------------------------------- |
| `root`    | 超級管理員 | damageable-command：可造成不可逆影響的操作            |
| `manager` | 管理者     | danger-command：影響全體成員的設定與管理              |
| `user`    | 成員       | 日常協作                                              |

- 唯一來源：後端 `server/app/permissions.py`（`CAPABILITIES`、`can(user, capability)`、FastAPI dependency `require(capability)`）；前端名稱表 `src/shared/permissions.ts`（pytest 比對兩邊一致）。
- 後端強制：不具權限一律 **403** `{"code": "FORBIDDEN", "message": "沒有權限執行此操作"}`。
- 前端只做顯示：`/api/auth/me` 與登入回應帶 `capabilities`（字串陣列），以 `useCan(capability)`（`src/web/lib/permissions.ts`）決定顯示 / 隱藏，不再以角色字串判斷。
- 顯示名稱表：`ROLE_LABELS`（`src/shared/users.ts`）。

## 權限矩陣

| capability            | 內容                                                         | user | manager | root |
| --------------------- | ------------------------------------------------------------ | :--: | :-----: | :--: |
| `tasks.edit`          | 任務新增 / 編輯 / 軟刪除（全員可互改）                       |  ✓   |    ✓    |  ✓   |
| `feedback.edit`       | 問題回饋                                                     |  ✓   |    ✓    |  ✓   |
| `personal.edit`       | 個人清單                                                     |  ✓   |    ✓    |  ✓   |
| `eng.edit`            | 工程追蹤的問題與 worktree 紀錄（含 GitHub 同步 / 匯入 / 建立 issue） |  ✓   |    ✓    |  ✓   |
| `projects.create`     | 建立專案                                                     |  ✓   |    ✓    |  ✓   |
| `properties.edit`     | 自訂欄位（property）                                         |  ✓   |    ✓    |  ✓   |
| `profile.edit`        | 自己的個人資料與密碼                                         |  ✓   |    ✓    |  ✓   |
| `members.manage`      | 成員新增 / 停用 / 啟用 / 重設密碼 / 解鎖 / 編輯；角色限 user ↔ manager |      |    ✓    |  ✓   |
| `statuses.manage`     | 狀態新增 / 改名 / 改色 / 排序 / 刪除                         |      |    ✓    |  ✓   |
| `projects.manage`     | 專案改名 / 改色 / 排序 / 封存                                |      |    ✓    |  ✓   |
| `github.manage`       | GitHub 連動（專案 ↔ repo 設定）                              |      |    ✓    |  ✓   |
| `data.export_json`    | JSON 匯出                                                    |      |    ✓    |  ✓   |
| `data.import_merge`   | 匯入（合併模式的預覽與套用）                                 |      |    ✓    |  ✓   |
| `data.backup_db`      | 完整資料庫 .db 備份下載（含密碼雜湊與 session）              |      |         |  ✓   |
| `data.import_replace` | 匯入「取代全部」模式                                         |      |         |  ✓   |
| `roles.assign_root`   | 指派 / 撤銷 root；管理 root 帳號（編輯、停用、重設密碼、解鎖） |      |         |  ✓   |

CLI（`python -m server.cli ...`，含 `restore`、`import --replace`）屬伺服器本機操作，不受此表限制。

## 端點對照

| 端點                                                           | 權限                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| `/api/admin/users*`（含未知的 `/api/admin/*`）                 | `members.manage`；目標或新角色為 root 時另需 `roles.assign_root` |
| `GET /api/admin/data/export`                                   | `data.export_json`                                        |
| `POST /api/admin/data/import/preview`、`/import/apply`（merge） | `data.import_merge`                                       |
| `POST /api/admin/data/import/apply`（`mode: "replace"`）        | 另需 `data.import_replace`                                |
| `GET /api/admin/data/backup`                                   | `data.backup_db`                                          |
| `POST /api/projects`                                           | 全員（`projects.create`）                                 |
| `PATCH /api/projects/:id`                                      | `projects.manage`                                         |
| `POST / PATCH / DELETE /api/statuses`                          | `statuses.manage`；刪除時仍有任務（含已刪除任務）使用 → 409，且至少保留一個狀態 |
| `PUT /api/eng/github-links`                                    | `github.manage`                                           |
| 其餘 API                                                       | 全員（登入即可）                                          |

## 規則

- **最後一位 root**：不可停用或降級最後一位啟用中的 root（409「至少需保留一位超級管理員」）。
- **manager 管理成員**：可新增 user / manager、在 user ↔ manager 間調整（含其他 manager 與自己）；看得到 root 但不能操作。
- **預設管理員**：首次啟動自動建立的 `ADMIN_USERNAME` 帳號為 root。
- **舊資料**：migration `0006_roles` 將既有 `admin` → `root`、`member` → `user`；之後以舊值寫入會自動轉換，其他值拒絕。舊版匯出檔的 `role` 仍可匯入（匯入建立的成員一律為 user）。

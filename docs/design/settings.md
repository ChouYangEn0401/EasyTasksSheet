# 個人設定（feat/settings）

使用者自己更新顯示名稱、帳號與密碼。入口：頂欄使用者選單 →「個人設定」（`/settings`）。任何角色皆可，只能改自己。

## API

| 方法與路徑                  | 說明                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/profile`          | `{ id, username, displayName, role, createdAt, lastLoginAt }`（`lastLoginAt` 取自最近一次 session 建立時間，可能為 null）。 |
| `PATCH /api/profile`        | body 可含 `displayName`、`username`、`currentPassword`；回傳同 GET 的最新資料。                                              |
| `POST /api/auth/password`   | 沿用既有端點改密碼（目前密碼、新密碼 ≥ 8 且不得為 `password`、成功後撤銷其他 session，目前 session 保持）。                  |

PATCH 規則：

- 未知欄位（含 `role`、`isActive`、`id`）一律 400，不會被默默忽略；角色只能由成員管理調整。
- `displayName`：trim、1–100 字。
- `username`：格式與唯一性同成員管理（trim、轉小寫、3–32 字元 `[a-z0-9._-]`、不可為 bootstrap 管理員帳號）；與目前帳號相同視為未變更。改帳號**必須**帶正確的 `currentPassword`（缺少 → 400，`details.field = currentPassword`；重複 → 409，`details.field = username`）。
- 改帳號後所有現有 session 保持有效。
- 所有寫入都在同一 transaction 內 `record_change('user', id, 'update')`；無實際變更時不寫入。

## 速率限制

驗證「目前密碼」統一走 `server/app/pwcheck.py: verify_current_password`（`/api/profile` 改帳號與 `/api/auth/password` 共用）：

- 先檢查既有登入失敗限制（同帳號 5 次 / IP），已鎖定回 429 + `Retry-After`。
- 密碼錯誤記為該帳號一次登入失敗（`login_attempts`），回 400，`details.field = currentPassword`。因此被盜用的 session 無法無限猜密碼，也會連帶鎖住該帳號登入。

## 前端

- 路由 `/settings`（`src/web/features/settings/`），頂欄標題「個人設定」。
- 三張卡片：
  - 個人資料：顯示名稱、帳號；只有帳號被改動時才出現「目前密碼」欄與說明。無變更不可儲存；錯誤（格式、重複、密碼錯誤）標在對應欄位；儲存中按鈕顯示 loading，成功後 toast「個人資料已更新」並更新頂欄。
  - 變更密碼：目前密碼、新密碼（規則提示 + 強度條）、確認；成功後清空表單並顯示「密碼已更新，其他裝置已登出」。
  - 帳號資訊：角色（唯讀）、建立時間、最近登入。
- 驗證為純函式（`model.ts`，vitest 覆蓋），規則與後端一致。`must_change_password` 的強制改密碼頁維持原樣。
- 768px 以下卡片縮小內距，無水平捲軸。

## 測試

- pytest：`server/tests/test_profile.py`（成功 / 失敗、帳號重複、改帳號需密碼、密碼錯誤計入限制、只能改自己、role 被拒）。
- vitest：`src/web/features/settings/model.test.ts`。
- E2E：`tests/e2e/settings.spec.ts`，自建專用測試成員（改顯示名稱 → 改密碼 → 其他裝置登出 → 改帳號），結束後以 admin 停用，不動共用帳號。

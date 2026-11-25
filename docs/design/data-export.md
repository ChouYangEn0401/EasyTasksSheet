# 設計規格 — feat/data-export（資料匯出與匯入，輕量）

管理者以上把資料帶走，或把另一套系統的資料匯入並處理衝突。頁面 `/admin/data`（側邊導覽「資料管理」，依 capability 顯示；
權限見 `docs/permissions.md`：JSON 匯出 `data.export_json`、合併匯入 `data.import_merge` 為 manager 以上；
「下載完整備份」`data.backup_db` 與「取代全部資料」`data.import_replace` 僅 root，其他角色不顯示該按鈕 / 卡片。
成員（user）進入顯示「沒有權限」，API 回 403）。只用 core-shell 的 token 與基礎元件（`Button`、`Alert`、`Dialog`、`Field`、`Input`、`Select`、`Badge`）。

## 1. 版面

`adm-page` 欄寬（最寬 960px），由上而下三張卡片（`dat-card`：surface 底、border、radius-lg、內距 16/20）：

1. **匯出**：兩段說明 + 兩個按鈕。
   - 「下載 JSON 匯出檔」（primary）：`GET /api/admin/data/export`，檔名 `tasks-sheets-export-YYYYMMDD-HHMMSS.json`。
   - 「下載完整備份」（secondary，鎖頭圖示）：先開 `alertdialog` 說明「含密碼雜湊與登入 session，屬敏感檔」與還原指令，
     按「我了解，下載」才下載 `GET /api/admin/data/backup`（`.db`）。說明文字中的敏感提示以 danger-text 色標示。
2. **匯入**：說明 → 「選擇匯出檔」→ 預覽 → 套用 → 結果。
3. **取代全部資料**（`dat-card--danger`：danger-border 邊框、標題 danger-text）：需先完成預覽；輸入確認字樣「取代全部資料」後
   danger 按鈕「取代並匯入」才可按，再經一次確認對話框。

## 2. 匯入流程與狀態

| 狀態     | 畫面                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------ |
| 空       | 「尚未選擇檔案」（tertiary 字）                                                                  |
| 載入     | 按鈕 loading +「正在分析檔案…」                                                                  |
| 錯誤     | danger Alert：訊息 + 最多 5 條細節（JSON 無效、非匯出檔、schemaVersion 較新、驗證失敗、過大 413） |
| 預覽     | 匯出時間、逐類別統計表、缺少成員、衝突清單、「取消」/「套用匯入」                                   |
| 結果     | success Alert（含自動備份檔名）、逐類別結果表、自動建立成員的臨時密碼（只顯示一次）、「完成」      |

- 統計表欄位：類別 / 檔案 / 新增 / 相同（略過）/ 衝突（>0 時以 warning Badge）；最後一列為成員（已存在 / 缺少 N）。
- **缺少成員**：列出帳號、顯示名稱與引用次數；`Select`：「略過指派（相關欄位留空）」（預設）/「自動建立成員（臨時密碼）」。
- **衝突**：全域策略 `Select`：以較新者為準（預設）/ 保留本機 / 使用匯入檔。每筆衝突為 warning-border 小卡：
  類別 Badge + 標題 + 右側逐筆覆寫 `Select`（「依全域策略（目前結果）」/ 保留本機 / 使用匯入檔）；下一行為雙方更新時間與
  哪邊較新；下方差異表（欄位 / 本機 / 匯入檔，空值顯示「（空）」）。
- 「套用匯入」→ 確認對話框：新增筆數、衝突中採用匯入檔的筆數、成員處理方式；套用前自動備份。
- 預覽 token 30 分鐘有效；過期時顯示錯誤並回到空狀態。內容與目前資料完全相同時顯示 info Alert，「套用匯入」停用。

## 3. 資料規則（後端 `server/app/data_transfer.py`，CLI 共用）

- 匯出：users（不含密碼雜湊）、statuses、projects、propertyDefs、tasks（含軟刪除，帶 deletedAt）、feedbackItems、
  personalItems、manualIssues、worktreeRecords、engGithubLinks、taskDependencies（任務依賴，以兩端任務 uid 表示；成環者匯入時略過，見 delay-link.md）。不含 sessions、login_attempts、changes 與快取 / 快照表。
  關聯以 uid（`0005_uid` migration，trigger 自動產生）表示；成員以 username、GitHub 連動以 project 為自然鍵。
- 對應：同 uid 為同一筆；狀態與專案 uid 對不到時以「名稱相同且唯一」對應（新安裝的預設資料不重複）。
- 相同：createdAt / updatedAt / updatedByUsername 以外欄位都相同。衝突：兩邊都有且內容不同。
- keep_newer：匯入檔 updatedAt 較新才採用，同時間保留本機。
- 套用：先 `VACUUM INTO` 備份到 `BACKUP_DIR`（`<db>-pre-import-<時間>.db`），再單一 transaction 寫入並 record_change；
  任何錯誤全數回滾。取代模式先刪除全部業務資料（成員保留）。
- 自動建立的成員：啟用中的 user（成員）、隨機臨時密碼、首次登入須改密碼。略過時：指派類欄位留空，個人清單（必須有擁有者）略過。

## 4. 給實作者的檢查清單

- [ ] 成員（user）：導覽無入口、頁面「沒有權限」、API 403；管理者（manager）看不到完整備份與取代全部（API 403）
- [ ] 完整備份下載前一定經過敏感性確認
- [ ] 取代模式需輸入確認字樣（前後端都檢查）
- [ ] 臨時密碼只在結果畫面出現，mutation 不留快取（gcTime 0）

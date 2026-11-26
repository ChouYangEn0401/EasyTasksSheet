# 整站搬家包（.etpack）

把整個網站（所有帳號與密碼雜湊、任務、設定、稽核紀錄、附件檔案）打包成**一個用密語加密的檔案**，在另一台 server 還原。用途：本機整理好資料後搬到正式 server、換機器、災難復原。

程式：`server/app/sitepack.py`（格式、加解密、還原）、`server/app/features/site_pack.py`（API）、`server/cli.py`（`pack-export`、`pack-import`、`allow-restore`）、前端 `src/web/features/admin/SitePackSection.tsx`、`src/web/features/auth/SetupRestorePanel.tsx`。測試：`server/tests/test_site_pack.py`。

## 使用方式

| 要做的事 | 網頁 | 指令（在專案資料夾） |
| -------- | ---- | -------------------- |
| 匯出 | root：資料管理 → 整站搬家包 → 建立（再輸入一次密碼）→ 記下密語 → 下載 | `python -m server.cli pack-export` |
| 還原到**全新** server | 登入頁 →「全新安裝？從整站搬家包還原」→ 選檔、貼上密語 | `python -m server.cli pack-import <檔> ` |
| 覆蓋**已有資料**的 server | 先在 server 本機執行 `deploy\windows\allow_restore.bat`，再由 root 在資料管理頁上傳、輸入密語、密碼與「取代全部」 | `python -m server.cli pack-import <檔> --replace --yes` |

## 安全設計

參考業界做法：GitLab（只能還原到相同版本、機密另外處理）、Discourse（還原要先開啟 allow restore 設定、會覆蓋整站）、Bitwarden（以密碼加密、可攜帶的匯出檔）、Jenkins（全新安裝的初始設定保護）。

**核心原則：要覆蓋有資料的 server，必須同時「在網站裡是 root」又「人在 server 機器上」。** 只靠網站密碼不夠（密碼可能外流、前端可能有 bug）；能開啟還原解鎖的人本來就能直接動 server 上的檔案，所以這條規則不會增加新的風險。

| 情況 | 條件（全部在後端檢查） |
| ---- | ---------------------- |
| 全新 server | 只有一個帳號、它還沒完成首次改密碼、沒有任何任務（`is_pristine`）。登入前即可還原；沒有資料可以損失，所以不需要其他條件。完成首次登入後就不再是全新 |
| 已有資料 | ① 權限 `data.import_replace`（固定只有 root，無法下放）② 再次輸入自己的密碼 ③ server 本機的還原解鎖（`allow-restore` 在資料庫旁寫入 `restore-unlock.json`，30 分鐘失效，還原成功一次就刪除）④ 輸入「取代全部」⑤ 正確的密語 |
| 任何還原 | 先把現有資料庫與附件完整備份到 `BACKUP_DIR`（`app-before-pack-restore-<時間>.db` 與 `.attachments`，不可略過，失敗就中止）；還原後清除所有 session、寫一筆稽核紀錄（來源 system） |
| 匯出 | 權限 `data.backup_db`（固定只有 root）＋再次輸入密碼；下載連結只給建立者、只能用一次、30 分鐘失效 |

其他：同一時間只允許一個還原（也限制 Argon2 同時佔用的記憶體）；上傳走 multipart，必須帶同源 Origin（CSRF）；大小上限 `PACK_MAX_MB`（預設 2048，反向代理的上傳上限也要放寬，否則改用指令）。

## 密語

- 從 EFF Large Wordlist（7772 字，見 `server/app/wordlist/README.md`）以 `secrets.choice` 隨機取 8 個字，約 103 位元。
- 只在建立時顯示一次，伺服器不保存。遺失就無法開啟搬家包。
- 輸入時容許大小寫、空白、換行、連字號差異（只取英文字母組成的字）。

## 檔案格式（formatVersion 1）

```
MAGIC "ETPACK\0\1"（8 bytes）
header 長度（4 bytes big-endian）＋ header JSON：
  {format, version, cipher: "aes-256-gcm", chunk: 1048576, noncePrefix(7 bytes),
   kdf: {name: "argon2id", t: 3, m: 65536 KiB, p: 4, salt(16 bytes)}}
段落 × N：ciphertext 長度（4 bytes）＋ AES-256-GCM(段落明文)
```

- 金鑰：Argon2id(正規化後的密語, salt) → 32 bytes。
- nonce = noncePrefix（7）＋段落序號（4，big-endian）＋最後一段旗標（1）；每段的 AAD 都是整個檔頭（MAGIC＋長度＋header JSON）。竄改任一位元、調換或刪除段落、截斷檔尾、在結尾追加資料都會驗證失敗。
- 明文是一個 zip：`manifest.json`、`app.db`（VACUUM INTO 的一致快照）、`attachments/<32 位十六進位>`。解開時只接受這三種檔名，避免路徑穿越。
- `manifest.json`：createdAt、createdBy、migrations（資料庫已套用的 migration）、各表筆數、附件清單、遺失的附件、app.db 的 SHA-256。

## 版本相容

搬家包的 migrations 必須是本機程式已知的子集合：搬家包較新 → 拒絕（請先更新 server 的程式）；較舊 → 還原後自動套用新的 migration。

## 還原流程（服務運行中可執行）

1. 解密到暫存資料夾，檢查 zip 內容、manifest、SHA-256、`PRAGMA integrity_check`、版本相容。
2. 再檢查一次還原條件（避免檢查與套用之間狀態改變）。
3. 持有資料庫鎖：完整備份現有資料 → `sqlite3.Connection.backup()` 把搬家包的資料庫寫入目前的連線 → 換上附件目錄 → 套用 migration → 清除 session → 清除權限快取。
4. 寫入稽核紀錄、刪除還原解鎖檔。

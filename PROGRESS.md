# PROGRESS

> ⚠️ 歷史紀錄（React + Vite 時期）。2.0 起前端改為原生 JS、不需 Node，見 CHANGELOG.md 與 docs/frontend.md。

專案：實驗室專案管理工具（TasksSheets）
最後更新：2026-11-25（第六輪功能與審查修正完成，整合分支 `integration/wave6`）

## 目前階段
第六輪（11 項功能）已合併到整合分支 `integration/wave6`（已包含 `main`），並完成 fable 三方審查與修正；審查修正分支收斂後再 ff-only 合併回 `main`，等待使用者驗收。後端為 **Python（FastAPI + uvicorn + SQLite）**，前端 React + Vite。
目前 worktree：主 worktree（`main`）與整合分支；各功能分支已合併。第五輪以前的驗收數字見下方各輪紀錄，**最新數字見「第六輪」**。

## 驗收狀態（第二階段 Python 重寫時；歷史數字）
- `npm run check` 全綠：vitest 141、pytest 132、lint、typecheck、build。
- `npm run test:e2e`（預設即 Python 後端）24/24。
- `npm run backup:self-test` 通過；備份→還原演練完成。

## 軌道追蹤（第二階段：Python 重寫，2026-11-25）

| 軌道 | 分支 | 狀態 | 說明 |
|---|---|---|---|
| 介面中文化 | feat/ui-zh | 已合併 | List/Kanban/Gantt 改為 清單/看板/甘特圖 |
| Python 核心 | core/py-backend | 已合併 | 認證、session、核心資料 API、migration、pytest |
| 總覽/回饋/個人 | feat/py-overview-feedback-personal | 已合併 | 後端移植 |
| 工程追蹤簡化 + 成員管理 | feat/py-eng-admin | 已合併 | 手動輸入優先；各人電腦以 token 回報 |
| 即時同步 | feat/py-sync | 已合併 | SSE + changes |
| 部署/文件/備份 | feat/py-deploy | 已合併 | Python 備份 CLI、README、systemd、Docker |
| 切換 | feat/cutover | 已合併 | 移除 TS 後端、E2E 穩定化（修兩個前端真 bug） |

（第一階段 TS 版 T1–T9 與 hotfix 皆已合併，後端部分已被 Python 版取代。）

## 使用者決策（2026-11-25）
- 被追蹤的專案視為在各人自己的電腦上；工程追蹤一切從簡：手動輸入 → 各人電腦回報集中管理 → 本地路徑 → GitHub（未做，可在問題連結欄貼 URL）。
- 閒置 60 分鐘、其餘預設值 OK；介面中文、簡潔；後端用 Python FastAPI + uvicorn。

## 仍存在的問題
1. Dockerfile、docker-compose、Caddyfile、systemd unit 未實測（本機無 docker/caddy）。
2. Git Bash 跑 vitest 會失敗，請用 PowerShell；npm 安裝用 `npm ci --ignore-scripts`。
3. 後端不強制「改密碼前不可使用其他 API」，僅前端導向。
4. IP 登入限制取 X-Forwarded-For 第一段；README 要求 HOST=127.0.0.1 搭配反向代理。
5. 「本週完成數」為近似值（done 類別且 updated_at 在本週）。
6. Python 端成員同條件排序為近似（無 ICU，中文筆畫序可能不同）；時區在無 tzdata 時對 Asia/Taipei 用固定位移。
7. T9 差異：部分頁面失敗仍用頁內提示列而非 toast；編輯衝突「採用」鈕未做。
8. 看板 PinButton 一直顯示；768–1023px 回饋頁拖曳時「取消排程」放置列未做（鍵盤可取消）。
9. Python 部分 docstring 仍寫「行為同 src/server/…」（歷史對照，src/server 已移除）。
10. E2E 在 Windows 偶見 ConnectionResetError [WinError 10054] 訊息，不影響結果。
11. Python 後端僅支援單一 worker（SSE 廣播中心與記憶體內狀態）。

## 待決策清單
- 是否需要 GitHub issue 自動匯入（目前未做）。
- 是否在 server 端強制改密碼前封鎖其他 API。
- 「本週完成」是否新增 completed_at 欄位。
- 預設管理員帳密設定方式（目前 .env 或啟動時隨機密碼印在主控台）。

## 第二輪修正（2026-11-25，使用者指示）
- 已修：IP 限制可偽造（新增 TRUSTED_PROXY，預設忽略 X-Forwarded-For；用 Caddy 時設 true）。
- 已修：「本週完成」改為精確算法（tasks.completed_at，migration 0003）。
- 已修：中文排序（後端不再近似排序，前端用 Intl.Collator('zh-Hant')）。
- 已加：選配 GitHub 連動（migration 0004）：貼 GitHub issue 網址自動解析、同步狀態/標題、專案連動 repo、匯入、從工具建立 issue；未設 GITHUB_TOKEN 時完全不顯示。
- 驗收：vitest 147、pytest 147、E2E 25/25。
- 說明：單一 worker 指 uvicorn 只能開一個行程（SSE 廣播狀態在記憶體），實驗室規模不受影響，維持現狀。
- 未實測：真實 GitHub API（token 權限、速率限制、分頁）、Docker/Caddy/systemd。
- 問題清單第 4、5、6 項已解決；其餘維持現狀（使用者指示）。

## 第三輪修正（2026-11-25，使用者指示）
- 後端預設綁 127.0.0.1（需區網連線才設 HOST=0.0.0.0）；新增根目錄入口 `main.py` 與 `requirements.txt`；前端已建置時不論模式都由後端提供頁面。
- 預設管理員改為 `admin` / `password`（移除隨機密碼）；首次登入強制重設「帳號＋密碼」；CLI `user-add` 預設建一般帳號（給密碼就直接設定、沒給就隨機），皆首次登入強制改密碼。
- 驗收：vitest 147、pytest 168、E2E 26/26。
- 注意：舊的 data/app.db 內管理員密碼是隨機的；要得到 admin/password 需刪除 data/app.db 後重新啟動。
- 預設密碼 password 很弱，僅靠「首次登入強制重設」保護；部署到對外環境前務必先自己登入完成重設。

## 第四輪修正（2026-11-25，使用者指示）
- 甘特圖改版（docs/design/gantt-polish.md）：時間軸填滿容器、預設刻度自動、長條內顯示標題、今天標籤不遮擋刻度、週末/今天淡底、分組標頭與「無排程任務」摘要列、左欄改為狀態點+標題+日期區間、未排程區併入同卡片。
- 新增「資料管理」（管理員）：完整資料庫備份下載（.db）、可攜 JSON 匯出、匯入（預覽→選策略 keep_newer/keep_local/use_import、可逐筆覆寫→套用前自動備份→單一 transaction）、取代模式需輸入確認字樣；CLI `server.cli export/import`；migration 0005 為業務表加 uid（trigger 自動補）。
- 驗收：vitest 160、pytest 190、E2E 28/28；前端已重建（dist/web）。
- 已知小問題：長條起點在畫面左側外時條內標題被切；768 寬分組標頭同時有逾期 Badge 時成員名稱會被截斷；匯入預覽 token 存在記憶體，重啟即失效；E2E 匯入的自動備份寫到 backups/（已 gitignore）。
- 提醒：啟動新版時會自動套用 migration 0005（為既有資料補 uid）；建議先 `python -m server.cli backup` 備份。

## 第五輪（2026-11-25，使用者連續指示）— 全部合併，等待驗收
已合併（皆 ff-only，無 merge commit；worktree 與分支已清理，`git worktree list` 只剩主 worktree）：
- 權限三層 root>manager>user（docs/permissions.md）；root 可在「權限設定」頁自訂管理者/成員權限，受保護項目只限 root。
- 自由待辦小狀態（延後/取消…）+ 詳情側欄；總覽「近三週」（緩和語氣，docs/product-principles.md）。
- 清單/看板可新增與管理狀態、專案下拉可直接建立與管理專案；個人設定頁（顯示名稱/帳號/密碼）。
- 多人在線（頂欄雲朵頭像、hover 卡片、任務層級提示）與併發驗證（docs/multi-user.md）。
- 工程追蹤：UI 修正、附件（圖片/檔案/影片含 Range）、連結預覽（SSRF 防護）、可自訂狀態、一鍵掃描本機專案、多台電腦回報「不見不等於刪除」（空回報攔截、回收區）。
- 資料：完整 .db 備份、JSON 匯出匯入（預覽→策略→逐筆覆寫）、多台電腦 sync-push 增量上傳（時間差大自動採新、相近進待確認衝突；管理者以上）。
- 修正：requirements.txt 改純 ASCII（cp950 下 pip 會失敗）、E2E 對負載敏感斷言重試一次（第六輪已取消，改為 `retries: 0`）。
- 交接文件：docs/HANDOFF.md、docs/MOVE-TO-SERVER.md（搬到 server 的逐步教學，已實測演練）。
驗收（main）：vitest 227、pytest 479、E2E 53/53、build 成功；以使用者真實 DB 的複本測試 migration（9→13），資料筆數不變、integrity ok。

## 仍存在的問題（更新）
- Docker/Caddy/systemd/scp 未實測；GitHub 連動只用假資料測過。
- 後端仍不強制「改密碼前封鎖其他 API」（使用者決定維持）。
- 附件檔案本體不隨 JSON 匯出/sync-push 同步（需用完整備份帶走）。
- 單一 worker 限制；E2E 計時敏感斷言曾偶發（第六輪已改為不重試，見下）。
- 使用者本機正在運行的 server 需重啟才會載入最新程式與 migration（啟動前建議先 `python -m server.cli backup`），並 Ctrl+F5。
- 網頁掃描只掃伺服器所在電腦，且需設定 WORKTREE_SCAN_ROOTS；掃描對不可信資料夾有殘餘風險（clean filter），已寫入文件。

## 第六輪（2026-11-25）— 11 項功能與 fable 三方審查，整合分支 `integration/wave6`
功能（皆有 docs/design 規格；migration 0013–0020）：
1. 相關任務與複製任務（0013 `task_relations`；`task_relations.py`）。
2. 任務待辦清單 checklist（0014 `task_checklist_items`；`task_checklist.py`；清單 / 看板 ☑ 徽章）。
3. 依賴與延遲鏈（0015 `task_dependencies`；`dependencies.py`、`dependency_calc.py`；`/tasks/delay-link`）。
4. 討論區與描述鎖定（0016 `task_comments`、0017 描述鎖定；`task_comments.py`；討論串、@提及、未讀徽章）。
5. 稽核與還原（0018 `audit_log`；`audit_log.py`、`audit.py`、`audit_events.py`；`/admin/audit`、任務活動歷史）。
6. 總覽排除（0019 `users.in_overview`）：root 預設不列入總覽，成員管理可切換。**升級提醒：0019 會把既有 root 的 in_overview 設為 0，升級後 root 不再出現在總覽成員卡（設計行為，可在成員管理重新開啟）。**
7. 匯報報告（0020 `personal_items.done_at`；`personal_report.py`）。
8. 全站復原 / 重做（純前端記憶體堆疊；`POST /api/tasks/:id/restore`）。
9. 清單拖曳（換群組 / 排序，接入復原）。
10. 甘特圖未排程任務拖曳排程。
11. 工程追蹤工作樹每人一份（`?user=<id|all>`）；另含「貼上 `git worktree list` 登記」。

第六輪新增 capability：`audit.view_task_history`、`audit.view`、`audit.revert`、`comments.write`、`comments.moderate`、`tasks.lock`（`eng.status.manage`、`eng.scan`、`sync.manage`、`sync.resolve` 等第五輪已有；完整矩陣見 docs/permissions.md）。匯出格式 `schemaVersion` 升為 2。

fable 三方審查與修正：
- 後端：M1、M2 與 m3–m8（驗證、稽核隱私與還原、匯入 / 同步規則、效能）。
- 前端：M1–M4 與 m1–m11（復原堆疊、拖曳 Esc、標題徽章、討論區與即時同步等）。
- 404 根因：任務刪除後，詳情的子資源查詢仍會重抓而得 404，屬真缺陷（非測試不穩）；已把任務子資源查詢移到詳情鍵下。**retries 政策改變**：`playwright.config.ts` 由 `retries: 1` 改為預設 `0`（`E2E_RETRIES` 可臨時覆寫，不得用重試掩蓋缺陷）。
- 文件與測試收尾：realtime-feedback 等待上限放寬為 5 秒（2 秒產品目標只做單次量測記錄）；E2E 資料衛生（`tests/helpers/hygiene.ts`，每個 spec 結束清自己的任務 / 待辦；core-shell、personal 的計數斷言改為專屬前綴）；768 寬討論區測試不再於驗收時 skip；HANDOFF / README / MOVE-TO-SERVER / permissions 等文件對照現況更新。

驗收數字（實測，`npm run check` 與 `$env:E2E_PORT=3230; npm run test:e2e`，retries 0）：vitest 429（38 檔）、pytest 690、E2E 96/96（連跑皆全綠、無 skip）（連跑兩次皆全綠）。

仍存在的問題：
- sync-push 不含任務關聯、依賴、討論區留言（待辦清單會同步；JSON 匯出 / 匯入有帶，不含留言已讀位置）。
- root 預設不列入總覽（0019，見上方升級提醒）。
- 整頁網頁截圖（視覺驗收）未做。
- Docker / Caddy / systemd 未實測；真實 GitHub API 未測。
- 甘特圖尚未畫依賴箭頭；依賴只支援 finish-to-start、延後以日曆天推算。
- 後端 5 處與測試 5 檔 docstring 仍寫「行為同 src/server/…」（歷史對照）。

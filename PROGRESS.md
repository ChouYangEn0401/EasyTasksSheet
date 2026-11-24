# PROGRESS

專案：實驗室專案管理工具（TasksSheets）
最後更新：2026-11-25

## 目前階段
全部完成並合併至 main，等待使用者驗收。後端已依使用者要求改為 **Python（FastAPI + uvicorn + SQLite）**，前端維持 React + Vite。
`git worktree list` 只剩主 worktree，無殘留分支。

## 驗收狀態（main）
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

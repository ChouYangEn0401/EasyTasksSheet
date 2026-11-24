# PROGRESS

專案：實驗室專案管理工具（TasksSheets）
最後更新：2026-11-24

## 目前階段
全部軌道已合併至 main（going-home 授權下完成）。CP0–CP5 皆通過，等待使用者驗收。
`git worktree list` 只剩主 worktree，無殘留 feat/*、hotfix/* 分支。

## 軌道追蹤

| 軌道名稱 | 分支 | worktree 路徑 | 負責 agent | 狀態 | 最後更新日期 | 阻塞原因 |
|---|---|---|---|---|---|---|
| 規劃文件 PLAN.md | main | - | 規劃者 fable | 已合併 | 2026-11-24 | - |
| core foundation | core/foundation | - | opus | 已合併 | 2026-11-24 | - |
| core auth-data | core/auth-data | - | opus | 已合併 | 2026-11-24 | - |
| core shell | core/shell | - | fable(low) 設計 + opus | 已合併 | 2026-11-24 | - |
| T1 task-list | feat/task-list | - | opus | 已合併 | 2026-11-24 | - |
| T2 task-kanban | feat/task-kanban | - | opus | 已合併 | 2026-11-24 | - |
| T3 gantt-overview | feat/gantt-overview | - | opus | 已合併 | 2026-11-24 | - |
| T4 feedback-calendar | feat/feedback-calendar | - | opus | 已合併 | 2026-11-24 | - |
| T5 personal | feat/personal | - | opus | 已合併 | 2026-11-24 | - |
| T6 eng-tracking | feat/eng-tracking | - | opus | 已合併 | 2026-11-24 | - |
| T7 admin-users | feat/admin-users | - | opus | 已合併 | 2026-11-24 | - |
| T8 deploy | feat/deploy | - | opus | 已合併 | 2026-11-24 | - |
| T9 realtime-feedback | feat/realtime-feedback | - | opus | 已合併 | 2026-11-24 | - |
| hotfix stub-tests | hotfix/stub-tests | - | opus | 已合併 | 2026-11-24 | 核心測試不再依賴 501/placeholder |
| hotfix e2e-selectors | hotfix/e2e-selectors | - | 協調者 | 已合併 | 2026-11-24 | - |
| hotfix core-polish | hotfix/core-polish | - | opus | 已合併 | 2026-11-24 | CSS 順序、Icon、UpdatedAt/Menu/Dialog、備份 script、kanban E2E 穩定化 |
| hotfix eng-report | hotfix/eng-report | - | opus | 已合併 | 2026-11-24 | 回報端點 token 驗證、is_merged 欄位（migration 0001） |

## 檢查節點
- CP0–CP4：通過（2026-11-24）
- CP5（main）：check 262 單元測試全綠、build 成功、E2E 24/24、backup 自測通過、npm audit 無 high/critical（4 個 moderate，皆 drizzle-kit dev 相依）、.env 與 DB 檔未入版控。
- CP5 未完成項：Caddy/Docker 設定未實測；兩人以上實際試用；正式環境 HTTPS 部署演練。

## 模型設定備註
- 規劃者實際使用 claude-fable-5-2（非 fable5.1 medium）；設計者使用 fable、實作者使用 opus 別名。Agent 工具無 effort 參數，思考深度以 prompt 文字要求。
- 期間遇 API 5 小時限額，T1–T4 agent 中斷後以 SendMessage 續跑，無資料遺失。

## 決策記錄（going-home 期間採用的預設值）
PLAN.md 第 9.1 節 Q1–Q17 全部採建議預設值。

## 仍存在的問題
1. Caddyfile、Dockerfile、docker-compose 未實際驗證（本機無 caddy/docker）；SSE 經 Caddy 的行為待實測。
2. E2E 冷啟動第一次執行偶發 `toHaveURL` 失敗（feedback-calendar / core-shell 各見過），重跑即過，原因未查明。
3. Git Bash 跑 vitest 會失敗，需用 PowerShell；npm 安裝需 `npm ci --ignore-scripts`（better-sqlite3 缺 VC++ 時 node-gyp 失敗，改用預編譯檔）。
4. 後端不強制 must_change_password 前不可使用其他 API，僅前端導向。
5. IP 登入限制取 X-Forwarded-For 第一段，直連 Node 時可偽造（同帳號鎖定仍有效；README 要求 HOST=127.0.0.1 搭配 Caddy）。
6. 「本週完成數」為近似值（done 類別且 updated_at 在本週），schema 無 completed_at。
7. 已合併的 drizzle/0000_init.sql 曾被直接修改（projects.color 預設），舊開發 DB 不套用；之後已改用 0001 migration 規範。
8. T9 與設計稿差異：看板拖放失敗等部分頁面仍用頁內提示列而非 toast；編輯衝突「採用」鈕與就地編輯 info toast 未做；自己編輯造成的移動不播 FLIP。
9. 看板 PinButton 目前一直顯示（設計稿建議 hover 才顯示）；取消標記後 focus 不自動移到下一列。
10. 768–1023px 回饋頁拖曳時「取消排程」放置列未做（鍵盤 Home 可取消）；鍵盤拿起跨月不自動換月。
11. Kanban 1280px 側欄展開時四欄靠水平捲動。
12. 舊 DB 升級後既有 worktree 紀錄 is_merged=0，需下次偵測/回報更正。
13. npm audit 4 個 moderate（drizzle-kit dev 相依）。
14. SSE 在 HTTP/1.1 下每分頁佔一條連線（6 條上限）；Caddy 走 HTTP/2 無此問題。

## 待決策清單（需使用者決定）
- Q5：被追蹤的 repo 是否在 server 上（目前採模式 A，並提供模式 B 回報腳本）。
- Q1–Q17 其餘皆採預設，驗收時請確認（特別是預設管理員帳密設定、閒置逾時 60 分鐘、GitHub 作為 issue 來源）。
- 「本週完成」是否改為新增 completed_at 欄位。
- 是否在 server 端強制改密碼前封鎖其他 API。

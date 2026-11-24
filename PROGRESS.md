# PROGRESS

專案：實驗室專案管理工具（TasksSheets）
最後更新：2026-11-24

## 目前階段
使用者已離開（going-home 授權，2026-11-24）：規劃視為核准，一路開發到底。
- CP0、CP1、CP2 已通過；第一波 1B（T5–T8）進行中；T9 待 CP3 後開始。

## 軌道追蹤

| 軌道名稱 | 分支 | worktree 路徑 | 負責 agent | 狀態 | 最後更新日期 | 阻塞原因 |
|---|---|---|---|---|---|---|
| 規劃文件 PLAN.md | main | - | 規劃者 | 已合併 | 2026-11-24 | - |
| core foundation | core/foundation | - | opus | 已合併 | 2026-11-24 | - |
| core auth-data | core/auth-data | - | opus | 已合併 | 2026-11-24 | - |
| core shell | core/shell | - | fable low 設計 + opus | 已合併 | 2026-11-24 | - |
| hotfix stub-tests | hotfix/stub-tests | - | opus | 已合併 | 2026-11-24 | 核心測試不再依賴 501/placeholder |
| hotfix e2e-selectors | hotfix/e2e-selectors | - | 協調者 | 已合併 | 2026-11-24 | core-shell E2E 選擇器 |
| T2 task-kanban | feat/task-kanban | - | opus | 已合併 | 2026-11-24 | - |
| T4 feedback-calendar | feat/feedback-calendar | - | opus | 已合併 | 2026-11-24 | - |
| T3 gantt-overview | feat/gantt-overview | - | opus | 已合併 | 2026-11-24 | - |
| T1 task-list | feat/task-list | - | opus | 已合併 | 2026-11-24 | - |
| T5 personal | feat/personal | ../TasksSheets-personal | opus | 進行中 | 2026-11-24 | - |
| T6 eng-tracking | feat/eng-tracking | ../TasksSheets-eng-tracking | opus | 進行中 | 2026-11-24 | - |
| T7 admin-users | feat/admin-users | ../TasksSheets-admin-users | opus | 進行中 | 2026-11-24 | - |
| T8 deploy | feat/deploy | ../TasksSheets-deploy | opus | 進行中 | 2026-11-24 | - |
| T9 realtime-feedback | feat/realtime-feedback | ../TasksSheets-realtime-feedback | - | 待辦 | 2026-11-24 | 依賴 CP3 |

## 檢查節點
- CP0 foundation：通過（2026-11-24）
- CP1 核心完成：通過（check 109 測試、E2E 4）
- CP2 第一波 1A：通過（check 166 測試、E2E 12）
- CP3、CP4、CP5：待辦

## 模型設定備註
- 規劃者實際使用 claude-fable-5-2（非 fable5.1 medium），effort 以 prompt 文字要求 medium。
- Agent 工具僅能指定 model（fable / opus），無 effort 參數；effort 以 prompt 文字要求。實作者使用 opus 別名（視為 opus5.5）。
- 前端設計稿由 fable（要求 low）產出，現存於 docs/design/。
- 期間曾遇 API 5 小時限額中斷（T1~T4 agent），限額重置後以 SendMessage 續跑，無資料遺失。

## 決策記錄（going-home 期間採用的預設值）
PLAN.md 第 9.1 節 Q1–Q17 全部採建議預設值。

## 問題清單
1. 本機 Git Bash 跑 vitest 會失敗，一律用 PowerShell；npm 安裝需 `npm ci --ignore-scripts`（better-sqlite3 缺 VC++ 時 node-gyp 失敗，改用預編譯檔）。
2. task-kanban E2E「拖曳改狀態與順序」偶發失敗（全套件跑時 cardTitles 順序斷言），待 hotfix 穩定化。
3. 核心待小修（凍結檔案，走 hotfix）：main.tsx 的 CSS import 順序（index.css 應最先載入，目前 feature CSS 需自行宣告 @layer 順序）、ui/Icon 缺 calendar/clock、ui/UpdatedAt 的 tabIndex 固定為 0 影響 Kanban roving tabindex。
4. 後端不強制「must_change_password 前不可使用其他 API」，僅前端導向。
5. IP 登入限制取 X-Forwarded-For 第一段，未經反向代理直連時可偽造（同帳號鎖定仍有效）。
6. 「本週完成數」為近似值（done 類別且 updated_at 在本週），schema 無完成時間欄位。
7. 已合併的 drizzle/0000_init.sql 被直接修改（projects.color 預設值），既有開發 DB 不會套用。
8. 總覽統計只靠 30 秒輪詢，T9 接 SSE 時需一併重抓。
9. npm audit 有 4 個 moderate（dev 相依），留待 CP5。

## 待決策清單（隔天詢問使用者）
- Q5：被追蹤的 repo 是否在 server 上（目前採模式 A，並提供模式 B 回報腳本）
- 其餘 Q1–Q17 皆採預設，請驗收時確認
- 「本週完成」近似算法是否可接受，或需新增 completed_at 欄位

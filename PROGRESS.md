# PROGRESS

專案：實驗室專案管理工具（TasksSheets）
最後更新：2026-11-24

## 目前階段
使用者已離開（going-home 授權，2026-11-24）：規劃視為核准，Step 2 起一路開發到底。

## 軌道追蹤

| 軌道名稱 | 分支 | worktree 路徑 | 負責 agent | 狀態 | 最後更新日期 | 阻塞原因 |
|---|---|---|---|---|---|---|
| 規劃文件 PLAN.md | main | - | 規劃者 | 已合併 | 2026-11-24 | - |
| core foundation | core/foundation | （主 worktree） | opus 實作者 | 進行中 | 2026-11-24 | - |
| core auth-data | core/auth-data | （主 worktree） | opus 實作者 | 待辦 | 2026-11-24 | 依賴 foundation |
| core shell | core/shell | （主 worktree） | 設計 fable low + 實作 opus | 待辦 | 2026-11-24 | 依賴 auth-data |
| T1 task-list | feat/task-list | ../TasksSheets-task-list | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T2 task-kanban | feat/task-kanban | ../TasksSheets-task-kanban | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T3 gantt-overview | feat/gantt-overview | ../TasksSheets-gantt-overview | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T4 feedback-calendar | feat/feedback-calendar | ../TasksSheets-feedback-calendar | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T5 personal | feat/personal | ../TasksSheets-personal | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T6 eng-tracking | feat/eng-tracking | ../TasksSheets-eng-tracking | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T7 admin-users | feat/admin-users | ../TasksSheets-admin-users | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T8 deploy | feat/deploy | ../TasksSheets-deploy | - | 待辦 | 2026-11-24 | 依賴 CP1 |
| T9 realtime-feedback | feat/realtime-feedback | ../TasksSheets-realtime-feedback | - | 待辦 | 2026-11-24 | 依賴 CP2、CP3 |

## 模型設定備註
- 規劃者實際使用 claude-fable-5-2（非 fable5.1 medium），effort 以 prompt 文字要求 medium。
- Agent 工具僅能指定 model（fable / opus），無 effort 參數；effort 一律以 prompt 文字要求。
- 實作者使用 opus（以 Agent 工具的 opus 別名，視為 opus5.5）。

## 決策記錄（going-home 期間採用的預設值）
PLAN.md 第 9.1 節 Q1–Q17 全部採建議預設值。

## 問題清單
（尚無）

## 待決策清單（隔天詢問使用者）
- Q5：被追蹤的 repo 是否在 server 上（目前採模式 A）
- 其餘 Q 皆採預設，請驗收時確認

# 童軍式重構紀錄（refactor/scout）

整合分支 `integration/wave6` 之後的一輪輕量整理：只做**不改變行為**的小步重構（API 路徑 / 欄位 / 狀態碼 / 錯誤文案、資料庫 schema 與 migration、UI 外觀與文案、權限名稱與預設值皆未變動）。每個主題一個 commit，commit 訊息內有「為什麼安全」的說明。

## 1. 做了哪些整理

| # | 主題 | 內容 | 保護 |
| - | ---- | ---- | ---- |
| 1 | 過時 docstring | 移除 9 處「行為同 src/server/…」「對應 …test.ts」（TS 後端已移除） | 只動註解 |
| 2 | 時區 / 日期工具 | 新增 `server/app/timeutil.py`（`get_zone`、`date_in_zone`、`local_midnight_ms`），原本放在總覽模組、被延遲鏈與匯報報告跨模組借用；「某日 00:00 的 ms」三份實作合一 | 既有 pytest + 新 `test_timeutil.py` |
| 3 | 稽核還原拆檔 | `audit.py`（約 1370 行）的還原流程（約 500 行）原樣搬到 `server/app/audit_revert.py`；`permission_cells` 留在 `audit.py` | `test_audit.py` 等 |
| 4 | 前端重複小工具 | `truncate` / `quoteName` / `quote` 三份截斷合一到 `lib/format.ts`；`toDateString` 合一；優先度中文名移到 `shared/tasks.ts` 的 `TASK_PRIORITY_LABELS` | vitest（補 truncate 特徵測試） |
| 5 | 匯出入定義拆檔 | `data_transfer.py` 的 SPECS 表（約 310 行）搬到 `server/app/data_transfer_specs.py`，`dt.SPECS` 等原名照常可用 | 匯出入 / sync-push pytest |
| 6 | 驗證型別 | `data_transfer` 的 `_Int` / `_Float`、`personal` 的 sortOrder 改用 `schemas.SqlInt` / `FiniteFloat`；uid 正規式抽成 `schemas.UID_PATTERN` | 相關 pytest |
| 7 | 時間常數 | `DAY_MS` / `MINUTE_MS` 統一由 `timeutil` 提供（取代 audit / security / eng 各自的定義與 `86_400_000` 魔術數字） | 相關 pytest |
| 8 | 測試與格式 | 測試中未使用的變數、無佔位符的 f-string；兩個整合後沒跑 prettier 的前端檔 | pytest / vitest |
| 9 | 死碼 | `stub_router` / `not_implemented`（501 佔位路由）、`security.random_password`、`useUpdateDependency`、`PencilIcon`、`FieldRowLabel` | 全專案 grep 無引用 |
| 10 | 長函式 | `audit_revert.plan_revert`（107 行 if 鏈）依類別拆成 `_plan_comment` / `_plan_set_fields` / `_plan_task` / `_plan_status_property` | 稽核還原 pytest（覆蓋率 86%） |

### 設計取捨

- **拆檔不留循環 re-export**：`audit_revert` 單向依賴 `audit`；唯一呼叫端 `features/audit_log.py` 直接改用 `audit_revert`，不在 `audit.py` 尾端反向 import。`data_transfer_specs` 則由 `data_transfer` 匯入同名符號，讓 `sync_push`、CLI、測試的 `dt.SPECS` 寫法不必改。
- **`today_local` 仍延後載入 config**：`dependency_calc` 其餘部分是純函式，import 時不應觸發 `.env` 讀取與設定驗證。
- **保留看似未用、但屬於 API 或文件明載的名稱**：`lib/hooks.ts` 的 `useCreateTask` / `useDeleteTask`（docs/core-interfaces.md、docs/design/undo.md 列為核心介面，實際畫面已改用 `features/tasks/data.ts` 的 `useOptimisticCreate` / `useDeleteTaskOptimistic`）、`undo.useUndoable`、`toast.dismissToast`、`changes.prune_changes`（見第 3 節）、`worktree_scan.valid_machine_id`（測試使用）。
- 新增模組沿用 `server/app` 現行多數的 snake_case 命名。

## 2. 已辨識但未處理（含理由）

| 壞味道 | 位置 | 為什麼這次不做 / 建議做法 |
| ------ | ---- | ------------------------- |
| 大型 React 元件 | `gantt/Gantt.tsx`（~1180 行）、`eng/WorktreesTab.tsx`（~1060）、`tasks/ListTable.tsx`（~850）、`admin/SyncPage.tsx`（~850）、`eng/IssuesTab.tsx` | 只有 E2E 保護，拆分需要先補元件層測試；建議先抽純函式（排版 / 計算）到同資料夾 model 檔再拆子元件 |
| mutation 樣板 | `features/eng/api.ts` 17 個 `useMutation + onSuccess: invalidate` | 可抽 `useInvalidatingMutation(queryKey, options)`（注意要回傳 invalidate 的 promise，`mutateAsync` 才會等重抓）；觸及面廣，留待前端專屬一輪 |
| `_is_done(conn, status_id)` 重複 | `features/tasks.py`、`audit_revert.py`、`features/projects.py` 行內 | 放到低層模組（例如新的 `statuses.py`）才不會讓 `audit_revert` 依賴 feature 模組 |
| 長函式 | `_overview_compute.compute_activity` / `compute_overview`（~120 行）、`eng.build_overview`（114）、`worktree_paste.parse_worktree_list`（113）、`sync_client.sync_push_cmd`（110）、`audit_revert._execute`（105，可改為 kind → handler 表）、`data_transfer._apply_dependencies`（94） | 每個都需要逐分支閱讀與補覆蓋，時間盒內只做了 `plan_revert` |
| 三份 YYYY-MM-DD 加減天數 | `personal/reportFormat.addDays`（本地 Date）、`calendar/dates.addDaysKey`（date-fns）、`gantt/timeline.addDays`（UTC 日序） | 合法輸入結果相同，但無效輸入的行為不同；合併前要先決定語意 |
| 測試樣板 | 多數 `server/tests/test_*.py` 自帶 `setup()`、`new_task` / `mk` 等建任務 helper | 可在 `helpers.py` 提供 `api_create_task()` 與常用 fixture；逐檔改動多、價值中等 |
| 文件列為核心介面、但沒有呼叫端的 hooks | `lib/hooks.ts` 的 `useCreateTask` / `useDeleteTask` | 要刪需同步改 docs/core-interfaces.md 與 docs/design/undo.md（文件由另一條分支負責），故本輪保留 |
| 未使用的列舉常數 | `audit.SOURCES`、`sync_push.RESOLUTIONS`（與 `Literal` 型別重複） | 僅有文件作用；可改為由 `typing.get_args()` 推得或刪除 |
| 只在本檔使用的 `export` | 前端約 200 個（多數是型別與 zod schema） | 移除 `export` 屬純粹的 churn；`src/shared/*.ts` 的 schema 是後端合約的鏡像，保留與否屬產品決策 |
| CSS 重複 / 寫死的顏色 | Menu / Popover / Dialog 樣式、各 feature css | 「視覺完全等價」無法自動驗證，需搭配截圖比對 |
| `server/e2e_setup.py` 帶 UTF-8 BOM | | Python 可正常讀取；只影響 `ast.parse` 類工具。屬 E2E 設定範圍，留給文件 / 測試分支 |
| 時間敏感的併發測試 | `test_concurrency.py::test_thirty_sse_connections_with_writes` | 單獨執行約 5 秒即通過，但收尾的 `wait_until(hub.size == 0, 5)` 等只給 5 秒；本輪曾在與 eslint / tsc 同時執行（CPU 滿載）時逾時一次。屬測試對機器負載敏感，非程式行為改變；可考慮把收尾等待放寬或改為事件通知 |
| `presence.py` 以副作用 import config | `from . import config as _config  # noqa: F401` | 用意是確保 `.env` 已載入；可改為明確呼叫，但牽涉啟動順序 |

## 3. 疑似真缺陷（未在此分支修改）

1. **（已修正，fix/post-refactor）`changes` 流水從未修剪**：`config.CHANGES_RETENTION_DAYS`（預設 30）與 `changes.prune_changes()` 都存在，文件也寫「changes 保留 30 天」，但全專案沒有任何地方呼叫 `prune_changes`（`audit` 有 `prune_on_startup` / `maybe_prune`，`changes` 沒有對應機制）。重現：`grep -rn prune_changes server/app` 只有定義；長期運作後 `changes` 表無上限成長（`/api/changes` 補漏與 SSE 查詢走主鍵索引，短期不影響效能，但 DB 與匯出備份會持續變大）。
2. **（已修正，fix/post-refactor）sync-push「每日首次同步前備份」用伺服器 OS 時區判斷日界線**：`sync_push._local_day()` 用 `datetime.fromtimestamp(ms / 1000)`（OS 本地時間），其餘日界線一律用 `config.TZ`。重現：在 OS 時區為 UTC 的 Linux 主機上，台北時間 07:59 與 08:01 的兩次同步會被視為不同日而各備份一次；台北 00:30 與前一天 23:30 則被視為同一天。

## 4. 建議的後續重構優先順序

1. 補上 `changes` 修剪（屬行為修正，另開 fix 分支）。
2. 前端 mutation 樣板 helper（eng / hooks / admin 等 api.ts）——低風險、可減少約 40 行。
3. `audit_revert._execute` 改成 kind → handler 表；`_overview_compute` 兩個 120 行函式拆分。
4. `server/tests/helpers.py` 補建任務 / 登入的共用 fixture，逐檔替換。
5. 大型 React 元件：先抽純函式並補 vitest，再拆子元件。

## 5. HANDOFF 檔案地圖待更新

- `docs/HANDOFF.md` §2 目錄地圖 `server/app/` 下可補：
  - `timeutil.py`：時區 / 日期純函式與 `DAY_MS`、`MINUTE_MS`
  - `audit.py` / `audit_revert.py` / `audit_events.py`：稽核紀錄（寫入與顯示 / 還原 / 各操作的稽核事件）
  - `data_transfer.py` + `data_transfer_specs.py`：JSON 匯出匯入核心（流程 / 資料類別定義 SPECS）
- §2 功能對應表「稽核與還原」列：`audit_log.py` + `audit.py` + `audit_events.py` 之外補 `audit_revert.py`；
  同節「`audit.py`、`audit_events.py`、`dependency_calc.py`、`personal_report.py` 位於 `server/app/`」一句補上
  `audit_revert.py`、`timeutil.py`、`data_transfer_specs.py`。
- §11 已知問題第 18 項（後端 5 處與測試 5 個檔案的 docstring 仍寫「行為同 / 對應 src/server/…」）已處理，可刪除。
- §11 第 9 項提到 `data_transfer.SPECS`：定義已移到 `data_transfer_specs.py`，但 `data_transfer.SPECS` 仍可取用，敘述不必改。
- （選擇性）若決定刪除 `lib/hooks.ts` 的 `useCreateTask` / `useDeleteTask`，`docs/core-interfaces.md` 第 11 行與 `docs/design/undo.md` 第 45–46 行要一起改為 `features/tasks/data.ts` 的 `useOptimisticCreate` / `useDeleteTaskOptimistic`。

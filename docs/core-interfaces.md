# Core 介面摘要（CP1 後凍結）

## 執行環境注意
- Windows 上請用 PowerShell 跑 npm（Git Bash 跑 vitest 會失敗），先 `$env:Path += ";C:\Program Files\nodejs"`。
- 後端為 Python（FastAPI + uvicorn）：先 `npm run py:install`；`npm run dev` 同時啟動 uvicorn（:3000，--reload）與 Vite（:5173，/api 代理到 PORT）；`npm run py:test` 跑 pytest；`npm run check` = lint + typecheck + test + py:test + build。
- E2E：`npm run test:e2e`（Playwright 以 `.venv` Python 執行 `server.e2e_setup` 建立全新 data/e2e.db 與測試帳號，再以 uvicorn 正式模式啟動）；`loginViaUi(page, E2E_USERS.admin, '/路徑')`（tests/helpers/e2e.ts）；帳號 admin（root）/ manager（manager）/ member（user）；權限判斷用前端 `useCan(capability)`（src/web/lib/permissions.ts）與後端 `require(capability)`（server/app/permissions.py），見 docs/permissions.md；newbie 僅供 core 冒煙測試。
- 登入 API 的 POST 即使無 body 也要帶 Content-Type: application/json。

## 前端 src/web/lib
- `api.ts`：api.get/post/put/patch/delete<T>(path, body?)（路徑不含 /api）；錯誤為 ApiError；401 自動導回登入；errorMessage(err)。
- `hooks.ts`：useTasks(filters?)、useTask(id)、useCreateTask、useUpdateTask({id,...patch})、useDeleteTask、useUsers、useProjects、useStatuses、useProperties、useUsersById/useProjectsById/useStatusesById（Map）。清單 30 秒輪詢 + focus 重抓。
- `queryClient.ts`：queryClient、queryKeys、LIST_POLL_MS。
- 篩選：useTaskFilters() → {filters,setFilters,clearFilters}；TaskFilters={q,project[],assignee[(number|'none')],status[]}；filters.ts 為純函式。
- `openTask.ts`：openTask(id)/closeTask()/readTaskParam(sp)。
- `auth.ts`：useMe、useCurrentUser、logout、handleSessionExpired、idleTracker、useIdleSnapshot。
- `shortcuts.ts`：suspendGlobalShortcuts()、isEditableTarget()、resolveUndoShortcut()；全域鍵 N/ // G/ [、Ctrl+Z / Ctrl+Shift+Z。
- `undo.ts`：registerUndoable({label,undo,redo})、useUndoable()、useUndoState()；任務 mutation（useUpdateTask 等）自動登記，`undo: false` 不入堆疊（docs/design/undo.md）。
- `format.ts`、`colors.ts`（tagVars、statusTone、statusStyle）、`storage.ts`、`useOnline.ts`。
- `GlobalOverlays.tsx`：空殼，AppShell 已掛載，T9 在此加 Toast/閒置提醒/SSE 狀態。

## 基礎元件（src/web/ui/index.ts）
Button、Input、Textarea、Field、Select、MultiSelect、Menu、Dialog、Badge、ColorDot、StatusBadge、Avatar、AvatarGroup、UpdatedAt、Checkbox、Tooltip、Spinner、Skeleton、EmptyState、ErrorState、PlaceholderPage、Kbd、Toast/ToastViewport（外觀）、Alert、Icon。

## Shell
- `<ViewTabsActions>` 把任務檢視控制項放到 ViewTabs 右側；`<NoFilterResults />`；FilterBar 由 TaskAreaLayout 自動顯示於三個任務檢視。

## 插槽
- `<QuickAdd defaults? fullWidth? placeholder? global? onCreated? />`（features/tasks，T1 升級）；defaults 可含 statusId、projectId、assigneeId、sortOrder。
- `<TaskDrawer />` 全域掛載，由 ?task=<id> 驅動（T1 升級）。
- `<PinButton taskId size? />`（features/personal，T5 實作；core 版回傳 null）。

## 後端（Python：server/app）
- 進入點 `server/app/main.py`（`python -m server.app` 或 `uvicorn server.app.main:app`）；各功能在 `server/app/features/*.py`；migration 為 `server/migrations/*.sql`（目前 0000–0020，下一個編號 0021）；測試在 `server/tests/`（pytest）。
- 前端共用型別 / zod schema 在 `src/shared/*.ts`（只剩前端使用者；後端回應格式須與之相符）。
- 管理指令：`python -m server.cli user-add | backup | restore`（npm：`user:add`、`backup`、`backup:self-test`）。
- 即時同步：`/api/events`（SSE）與 `/api/changes?since=`；前端收到任務刪除事件時不重抓該任務詳情（避免 404）。
- Session 9 小時 + 閒置 60 分鐘；只有非 GET 請求刷新閒置。
- tasks API：GET 支援 project/assignee/status 逗號多值、assignee=none、q；POST 只需 title；PATCH 只送改動欄位；軟刪除；`POST /api/tasks/:id/restore` 還原（復原用）。
- 自訂 property 值存 tasks.custom，PATCH 逐鍵合併，null 清除。
- TAG_COLORS：gray blue purple green yellow orange red teal。

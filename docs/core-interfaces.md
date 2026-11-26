# Core 介面摘要（CP1 後凍結）

## 執行環境注意
> 2.0（2026-11-26）起整個系統只剩 Python：前端從 React + Vite（TypeScript）改成 `web/static/js/` 底下的原生 ES modules（Preact 10），沒有建置步驟。下面的介面名稱與參數形狀照舊，只是檔案從 `src/web/**/*.ts(x)` 變成 `web/static/js/**/*.js`。架構見 [frontend.md](frontend.md)。

- 只需要 Python 3.11+：`python scripts/install.py`（`--dev` 另裝測試套件）→ `.venv/bin/python main.py --reload`（Windows：`.venv\Scripts\python main.py --reload`），開 http://localhost:3000。改前端重新整理即可。
- 測試：`.venv/bin/python -m pytest server -q`（後端；含 `test_web_modules.py` 前端模組連結檢查）。沒有 vitest、eslint、tsc。
- E2E：`.venv/bin/python -m pytest tests/e2e -q`（Python 版 Playwright；`tests/e2e/conftest.py` 執行 `server.e2e_setup` 建立全新 data/e2e.db 與測試帳號，再以正式模式在 3999 啟動）；`login_via_ui(page, E2E_USERS["admin"], "/路徑")`（`tests/e2e/helpers.py`，帳號來源 `server/e2e_setup.py`）；帳號 admin（root）/ manager（manager）/ member（user）；權限判斷用前端 `useCan(capability)`（`web/static/js/lib/permissions.js`）與後端 `require(capability)`（server/app/permissions.py），見 docs/permissions.md；newbie 僅供 core 冒煙測試。
- 登入 API 的 POST 即使無 body 也要帶 Content-Type: application/json。

## 前端 web/static/js/lib
- `api.js`：api.get/post/put/patch/delete(path, body?)（路徑不含 /api）；錯誤為 ApiError；401 自動導回登入；errorMessage(err)。
- `hooks.js`：useTasks(filters?)、useTask(id)、useCreateTask、useUpdateTask({id,...patch})、useDeleteTask、useUsers、useProjects、useStatuses、useProperties、useUsersById/useProjectsById/useStatusesById（Map）。清單 30 秒輪詢 + focus 重抓。
- `queryClient.js`：queryClient、queryKeys、LIST_POLL_MS（`QueryClient` 等由自寫的 `query.js` 提供，react-query 子集）。
- 篩選：useTaskFilters() → {filters,setFilters,clearFilters}；TaskFilters={q,project[],assignee[(number|'none')],status[]}；filters.js 為純函式。
- `openTask.js`：openTask(id)/closeTask()/readTaskParam(sp)。
- `auth.js`：useMe、useCurrentUser、logout、handleSessionExpired、idleTracker、useIdleSnapshot。
- `shortcuts.js`：suspendGlobalShortcuts()、isEditableTarget()、resolveUndoShortcut()；全域鍵 N/ // G/ [、Ctrl+Z / Ctrl+Shift+Z。
- `undo.js`：registerUndoable({label,undo,redo})、useUndoable()、useUndoState()；任務 mutation（useUpdateTask 等）自動登記，`undo: false` 不入堆疊（docs/design/undo.md）。
- `format.js`、`colors.js`（tagVars、statusTone、statusStyle）、`storage.js`、`useOnline.js`。
- `router.js`（react-router 子集：createBrowserRouter、Link、NavLink、useNavigate、useSearchParams…）、`dnd.js`（dnd-kit 子集）、`query.js`（react-query 子集）：見 [frontend.md](frontend.md)。
- `GlobalOverlays.js`：空殼，AppShell 已掛載，T9 在此加 Toast/閒置提醒/SSE 狀態。

## 基礎元件（web/static/js/ui/index.js）
Button、Input、Textarea、Field、Select、MultiSelect、Menu、Dialog、Badge、ColorDot、StatusBadge、Avatar、AvatarGroup、UpdatedAt、Checkbox、Tooltip、Spinner、Skeleton、EmptyState、ErrorState、PlaceholderPage、Kbd、Toast/ToastViewport（外觀）、Alert、Icon。

## Shell
- `<ViewTabsActions>` 把任務檢視控制項放到 ViewTabs 右側；`<NoFilterResults />`；FilterBar 由 TaskAreaLayout 自動顯示於三個任務檢視。

## 插槽
- `<QuickAdd defaults? fullWidth? placeholder? global? onCreated? />`（features/tasks，T1 升級）；defaults 可含 statusId、projectId、assigneeId、sortOrder。
- `<TaskDrawer />` 全域掛載，由 ?task=<id> 驅動（T1 升級）。
- `<PinButton taskId size? />`（features/personal，T5 實作；core 版回傳 null）。

## 後端（Python：server/app）
- 進入點：根目錄 `main.py`（`python main.py`）；應用組裝在 `server/app/main.py`（`python -m server.app` 或 `uvicorn server.app.main:app` 也可）；各功能在 `server/app/features/*.py`；migration 為 `server/migrations/*.sql`（目前 0000–0020，下一個編號 0021）；測試在 `server/tests/`（pytest）。
- 前端共用常數與名稱表在 `web/static/js/shared/*.js`（1.x 的 zod schema 與 TypeScript 型別已移除；資料驗證以後端 pydantic 為準，前端名稱表如 `permissions.js` 須與後端一致）。
- 管理指令：`python -m server.cli user-add | backup | restore`（`--help` 看全部；1.x 的 npm 別名已移除）。
- 即時同步：`/api/events`（SSE）與 `/api/changes?since=`；前端收到任務刪除事件時不重抓該任務詳情（避免 404）。
- Session 9 小時 + 閒置 60 分鐘；只有非 GET 請求刷新閒置。
- tasks API：GET 支援 project/assignee/status 逗號多值、assignee=none、q；POST 只需 title；PATCH 只送改動欄位；軟刪除；`POST /api/tasks/:id/restore` 還原（復原用）。
- 自訂 property 值存 tasks.custom，PATCH 逐鍵合併，null 清除。
- TAG_COLORS：gray blue purple green yellow orange red teal。

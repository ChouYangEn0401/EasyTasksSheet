# 任務討論區與描述鎖定

軌道：`feat/task-discussion`。使用者需求：任務詳情（inspector）下方要有讓大家和 manager 溝通的「聊天室」，可建立子討論（討論串），空間要顧好、不要無限往下長，捲軸要好好設計；任務由 PM 派發後描述通常不該被改，需要可以鎖定，大家的筆記改寫在下方討論區。

語氣原則（[product-principles.md](../product-principles.md)）：介面親切、中性。鎖定不是不信任，是「避免誤改，歡迎在討論區補充」。

## 1. 版面：抽屜的三段式穩定版面

```
┌ 標題列（固定）  #12   🔖  ☰  ✕ ┐
│ 他人變更提示 / 在線提示          │
├─────────────────────────────────┤
│ 內容區（.task-drawer-body）     │ ← 唯一會隨欄位變長的區域，自己捲動（.scroll-soft）
│  標題 / 狀態 / 欄位 / 自訂欄位  │
│  描述（含鎖定提示條）           │
├─────────────────────────────────┤
│ 建立於 · 更新於（固定）         │
├─────────────────────────────────┤
│ 討論 61  [全部|未解決|與我有關] ⤢ │ ← 討論區標題列（點標題可收合）
│ ┌ 捲動區（.disc-scroll）──────┐ │ ← 固定高度 clamp(240px, 42vh, 460px)
│ │ 載入更早的討論               │ │   頂端 / 底端淡出陰影提示還有內容
│ │ 討論串…                      │ │
│ │          ↓ 有新訊息          │ │
│ └──────────────────────────────┘ │
│ 輸入框（固定在討論區底部）      │
└─────────────────────────────────┘
```

- 討論區是 `flex: none` 的獨立區塊，高度固定為 `clamp(240px, 42vh, 460px)`（視窗高度 ≤ 640px 時 `clamp(200px, 46vh, 320px)`）；訊息再多也只在捲動區內捲動，**抽屜本身不會被撐長**。
- 還沒有任何討論時縮成 `clamp(200px, 28vh, 240px)`，把空間留給上方欄位；空狀態改為橫向（圖示在左、文字在右）。
- **聚焦模式**：標題列右側「⤢ 展開討論區」切換為佔滿抽屜（隱藏內容區與頁尾，抽屜標題列保留）；再按一次、或按 `Esc`（焦點不在輸入框時）還原。
- **收合**：點「討論」標題收合成只剩標題列（`aria-expanded`）。
- 輸入框在捲動區之外，所以永遠固定在底部（不需要 `position: sticky`）。

## 2. 捲軸設計（`.scroll-soft`，`src/web/features/tasks/scroll-soft.css`）

可重用的 CSS 類別，套用在抽屜內容區、討論捲動區與輸入框：

| 項目 | 規格 |
| --- | --- |
| 寬度 | 8px 軌道；滑塊以 2px 透明邊框做出 4px 視覺寬度，滑過滑塊時加寬到 6px |
| 顏色 | 平常 `text-tertiary` 28%；容器 hover / focus-within 時 55%；滑過或拖曳滑塊時 `text-secondary` 70% |
| 形狀 | 圓角 `radius-full`，最小高度 32px，軌道透明 |
| 穩定 | `scrollbar-gutter: stable`（出現捲軸時內容不跳動）；觸控裝置（`pointer: coarse`）改 `auto` 使用系統浮動捲軸 |
| 穿透 | `overscroll-behavior: contain`（捲到底不會帶動後面的清單） |
| 瀏覽器 | Chromium / Safari 用 `::-webkit-scrollbar`；不支援者（Firefox）以 `@supports not selector(::-webkit-scrollbar)` 改用 `scrollbar-width: thin` + `scrollbar-color`（Chromium 只要設了這兩個屬性就會忽略 webkit 樣式，所以必須分開） |
| 無障礙 | 捲動區可聚焦（`tabIndex=0`，`role="log"`），`:focus-visible` 內縮外框；`forced-colors` 模式交還系統捲軸 |
| 提示 | 討論捲動區頂端 / 底端 14px 漸層陰影，只在該方向還有內容時出現 |

## 3. 討論串

- **只支援兩層**：根訊息 + 回覆；回覆一律掛在根訊息下（API 驗證），「回覆某則回覆」只記 `replyToId`，顯示為「回覆 @某人」。
- 排序：以「串內最新活動時間」排序，**最新的在最下方**（像聊天室）；API 由新到舊分頁，每頁 20 串，頂端「載入更早的討論」以游標載入（載入後保持目前捲動位置）。
- 回覆預設**收合**：根訊息下方只顯示「N 則回覆 · 最後回覆 X 分鐘前」；展開後在串內縮排（左側細線）顯示最新 5 則，「顯示更早的回覆（N）」先展開已載入的（列表每串附最新 10 則），再向 `/replies` 載入更早的。
- 已解決的討論串：上方顯示「✓ 已解決 · 誰 · 何時」，內容淡化（hover 時恢復）、預設收合成一行，可「展開」。
- 動作：滑鼠移入（或鍵盤聚焦）訊息時右上角浮出小工具列：「回覆」、根訊息的「✓ 標記為已解決 / 重新開啟」與「⋯」（編輯、刪除）。平常不佔版面；觸控裝置一直顯示。
- 篩選列：「全部 / 未解決 / 與我有關（我發的訊息或提到我）」，只篩選已載入的討論串。

## 4. 訊息呈現

- 頭像、名字、相對時間（hover / focus 顯示絕對時間與編輯時間）、「已編輯」。
- 內容為純文字（不渲染 HTML），保留換行；`@帳號`（存在的成員）顯示為淡色晶片「@顯示名稱」，提到自己時為暖色；`http(s)://` 網址自動連結（新分頁、`rel="noopener noreferrer"`，尾端標點與全形標點不算網址）。
- 超過 8 行（或很長的單段文字）自動摺疊，「展開全文 / 收合」。
- 軟刪除：顯示「此訊息已刪除」（斜體、虛線頭像），保留討論串結構；整串都刪除的討論串不再列出。
- 空狀態：「還沒有討論。有想法、疑問或筆記，都可以寫在這裡。」

## 5. 輸入框

- 自動增高，最多 6 行後在框內捲動。
- `Enter` 送出、`Shift+Enter` 換行；IME 組字中（`isComposing` / keyCode 229）`Enter` 不送出。下方提示「Enter 送出 · Shift+Enter 換行」，剩 500 字內顯示剩餘字數，超過 4000 字顯示「超過上限」並停用送出。
- `@` 開啟成員選單（只列啟用成員，依帳號 / 顯示名稱過濾，開頭相符優先）：上下鍵移動、`Enter` / `Tab` 選取、`Esc` 關閉；選取後插入 `@帳號 `。
- 回覆模式：上方顯示「回覆 @某人 的訊息 ✕」，`Esc` 或 ✕ 取消。
- 送出後立即顯示樂觀訊息（「傳送中…」）；成功時直接放進快取再重抓校正；失敗顯示錯誤與「重試 / 捨棄」。
- 草稿以任務為單位存在 localStorage（`tasks-sheets:discussion-draft:<taskId>`），切換任務、重新整理都不遺失；送出後清除。
- 沒有 `comments.write`：輸入框改為唯讀說明「你目前可以閱讀討論，但沒有留言的權限；需要的話請洽管理者。」

## 6. 未讀與即時

- 未讀 = 他人的未刪除留言且 id 大於自己在此任務的已讀位置（`task_comment_reads`）；自己的留言不算未讀。
- `GET /api/tasks`、`GET /api/tasks/:id`（以及建立 / 更新任務的回應）帶 `commentCount`（未刪除留言數）與目前使用者的 `unreadComments`，以單一聚合查詢計算。
- 開啟任務時：捲到第一則未讀並顯示「未讀」分隔線（分隔線固定在進入時的位置）；未讀在收合的回覆中時自動展開該串；沒有未讀則捲到最新。開著討論區且視窗在前景時自動標記已讀（`POST …/comments/read`，只影響自己，不記變更流水）。
- 他人新留言經 SSE（變更流水 entity `task_comment`）即時出現：原本在底部就跟著捲，否則顯示「↓ 有新訊息」跳轉鈕，不強制捲動；不會覆蓋正在輸入的草稿。
- 清單列與看板卡片：`commentCount > 0` 時標題旁顯示「💬 N」小徽章（線條圖示，非 emoji），有未讀時加強調色小圓點；Tooltip「N 則討論，M 則未讀」。@提及沿用未讀徽章，不另做通知系統。

## 7. 描述鎖定

- 任務欄位 `description_locked`、`locked_by`、`locked_at`（migration 0017）；API 欄位 `descriptionLocked`、`lockedBy`、`lockedAt`。
- 權限 `tasks.lock`（預設 manager 以上）：可鎖定 / 解鎖，**鎖定後仍可修改描述**。
- 後端強制：
  - 任務已鎖定時，沒有 `tasks.lock` 的人 PATCH `description`（內容有變）→ 403「描述已由管理者鎖定，請把補充寫在討論區」；送出相同內容不擋；其他欄位不受影響。
  - PATCH / POST 帶 `descriptionLocked` 需 `tasks.lock`，否則 403「沒有權限執行此操作」。
  - 匯入與 sync-push 由 manager 以上執行，鎖定欄位隨資料寫入、不另擋。
- 前端：描述標題旁的鎖頭按鈕（有 `tasks.lock` 才可切換；Tooltip「鎖定後，成員無法修改描述，只能在討論區留言」）；鎖定時描述上方淡色提示條「🔒 描述已鎖定（由 XX 於 時間）。有補充或筆記，歡迎寫在下方討論區。」（有權限者看到「你仍可以修改」），描述改為唯讀（可選取複製）；清單列與看板卡片標題旁顯示小鎖頭。唯一的就地描述編輯入口是抽屜的描述欄。
- 未做：快速新增旁的「建立後鎖定描述」（API 已支援 `descriptionLocked: true`，介面只在詳情提供）。

## 8. 資料與 API

`task_comments`（0016）：`id`、`uid`（0005 trigger 作法）、`task_id`（FK cascade）、`parent_id`、`reply_to_id`、`author_id`、`body`（1–4000 字，純文字）、`mentions`（user id JSON 陣列，後端解析 `@帳號` 並驗證為啟用中成員）、`created_at`、`updated_at`、`edited_at`、`deleted_at`、`deleted_by`、`thread_resolved_at` / `thread_resolved_by`（僅根訊息）；索引 `(task_id, created_at)`、`parent_id`、`(author_id, created_at)`（速率限制用）。`task_comment_reads(user_id, task_id, last_read_comment_id, last_read_at)`。

| 端點 | 說明 |
| --- | --- |
| `GET /api/tasks/:id/comments?limit=&before=` | 最近的討論串（預設 20、上限 50），每串附最新 10 則回覆、`replyCount`、`lastActivityAt`；回應 `{threads, hasMore, nextBefore, lastReadCommentId}`；`before` 為 `<活動時間>_<根訊息 id>` 游標 |
| `GET /api/tasks/:id/comments/:rootId/replies?before=&limit=` | 某串較早的回覆（舊→新）與 `hasMore` |
| `POST /api/tasks/:id/comments` | `{body, parentId?, replyToId?}`；回 201 與留言 |
| `PATCH /api/tasks/:id/comments/:cid` | 只限作者；保留 `editedAt` |
| `DELETE /api/tasks/:id/comments/:cid` | 作者或 `comments.moderate`；軟刪除 |
| `POST /api/tasks/:id/comments/:rootId/resolve`、`/unresolve` | 根訊息作者、任務負責人或 `comments.moderate` |
| `POST /api/tasks/:id/comments/read` | 已讀到最新（不受寫入守門、不記變更流水） |

- 速率限制：同一使用者每分鐘最多 30 則（429「留言有點太快了，請稍候一分鐘再繼續」）。
- 變更流水：留言寫入記 `task_comment`（entity_id = 留言 id）；前端 `lib/sync.ts` 對應失效 `['taskComments']` 與任務清單（徽章）。刻意**不**記 `task`，避免他人畫面出現「剛更新了此任務」提示與列高亮；鎖定 / 解鎖屬任務欄位，記 `task`。
- 匯出 / 匯入：新增類別 `taskComments`（`taskUid`、`parentUid`、`replyToUid`、成員以帳號表示、`mentionUsernames`）；不在 `SPECS` 中，所以 **sync-push 不同步留言**。匯入時同 uid 視為同一則，依策略（updatedAt）決定是否覆寫；所屬任務未匯入時略過；成員不存在時該欄位留空。預覽回應 `taskComments: {total, new, existing, local}`，套用結果 `taskComments: {created, updated, unchanged, skipped, skippedReasons}`（資料管理頁尚未顯示這兩組數字）。任務另匯出 `descriptionLocked`、`lockedByUsername`、`lockedAt`（舊檔沒有時視為未鎖定）。

## 9. 已知限制

- sync-push（多台電腦同步）不同步留言與已讀位置。
- 稽核只存留言前 200 字摘要（發表、編輯前後、刪除）。這些摘要**只在全站稽核頁**（`audit.view`，預設管理者以上）可見，
  供管理者審視 / 還原誤貼的敏感內容；任務活動歷史（`/api/tasks/:id/history`，預設全員）對留言紀錄只顯示摘要句、不回傳內容，
  因此已刪除留言與編輯前的內容不會經由任務歷史外流（見 [audit-log.md](audit-log.md)）。
- 匯入留言時檢查討論串結構：父留言須屬同一任務且本身是根訊息（只有兩層）、`replyToUid` 須在同一串，違規者略過並列在
  `taskComments.skippedReasons`；更新既有留言不改其所屬任務與討論串。
- 沒有獨立的通知系統：@提及只反映在未讀徽章。
- 「與我有關」等篩選只作用在已載入的討論串。
- 載入過的較早回覆不會隨他人編輯 / 刪除即時更新（重新開啟任務即更新）。
- 軟刪除的訊息內容仍保留在資料庫與 JSON 匯出檔（API 不回傳）。
- 他人正在輸入的提示未做。

## 10. 檔案

- 後端：`server/app/features/task_comments.py`、`server/migrations/0016_task_comments.sql`、`0017_task_description_lock.sql`；`tasks.py`（鎖定、聚合欄位）、`permissions.py`、`data_transfer.py`（純新增）。
- 前端：`src/web/features/tasks/DiscussionSection.tsx`（版面、捲動、未讀）、`DiscussionThread.tsx`（討論串與訊息）、`DiscussionComposer.tsx`（輸入框）、`discussionModel.ts`（純函式）、`discussionApi.ts`、`DescriptionLock.tsx`、`TaskBadges.tsx`、`discussion.css`、`scroll-soft.css`。
- 測試：`server/tests/test_task_comments.py`、`src/web/features/tasks/discussionModel.test.ts`、`tests/e2e/task-discussion.spec.ts`（設 `DISCUSSION_SHOTS=<資料夾>` 會輸出版面截圖）。

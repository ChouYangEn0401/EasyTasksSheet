# 設計規格 — feat/task-kanban（T2）

適用分支：`feat/task-kanban`，檔案範圍 `src/web/features/kanban/**`，路由 `/tasks/kanban`。
token 與基礎元件一律引用 `core-shell.md`（以下標「core §n」），本文件不新增色碼、尺寸變數或基礎元件。

## 1. 範圍

- 欄 = 狀態（`statuses` 依 `sort_order`）；卡片跨欄拖曳改狀態、欄內拖曳改順序（寫入 `tasks.sort_order`，重整後保留）。
- 引用插槽：`QuickAdd`（每欄底部）、`openTask(id)`（點卡片）、`PinButton`（卡片右上）；篩選沿用 core `FilterBar`。
- 不做：狀態欄的新增 / 改名 / 排序、泳道分組、WIP 上限、卡片就地編輯（編輯走 TaskDrawer）。

## 2. 版面線框

```
 ViewTabs： List  [Kanban]  Gantt                                  （actions 插槽：留空）
 FilterBar：[🔍 搜尋任務…] [專案 ▾] [負責人 ▾] [狀態 ▾]  清除篩選            共 42 筆
 ────────────────────────────────────────────────────────────────────────────────
 ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
 │● 待辦  18  Σ36h│ │● 進行中 9 Σ24h │ │● 審查中 3  Σ8h │ │● 完成  42      │ ← 欄首（固定）
 │┌──────────────┐│ │┌──────────────┐│ │                │ │┌──────────────┐│
 ││● 預設專案  📌││ ││ 卡片         ││ │ 拖曳卡片到這裡  │ ││ 卡片         ││
 ││設計登入頁版面 ││ │└──────────────┘│ │ （空欄提示）    │ │└──────────────┘│ ← 欄身（各自垂直捲動）
 ││(王) 11/28 6h ││ │┌──────────────┐│ │                │ │ 顯示其餘 12 筆  │
 ││      3 小時前 ││ ││ 卡片         ││ │                │ │                │
 │└──────────────┘│ │└──────────────┘│ │                │ │                │
 │[+ 新增任務…   ]│ │[+ 新增任務…   ]│ │[+ 新增任務…   ]│ │[+ 新增任務…   ]│ ← 欄尾 QuickAdd（固定）
 └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘
   欄寬 288px、欄距 --space-3；看板在自身容器內水平捲動，不撐破 shell（core §9）
```

看板容器高度 = 視窗高 − Header − ViewTabs − FilterBar − 上下內距（`--space-6`），欄高填滿容器。

## 3. 元件與狀態

### 3.1 KanbanColumn

| 部位 | 規格 |
|---|---|
| 容器 | 寬 288、底 `--color-bg`、`--radius-lg`、內距 `--space-2`；無邊框、無陰影 |
| 欄首 | 高 36；狀態色點 8px（`--color-status-*`，取色規則同 StatusBadge）+ 名稱 `--text-sm` 600 + 計數 Badge（neutral、`--radius-full`）；右側 `Σ 36h` `--text-xs` text-tertiary（該欄預估工時合計；`done` 類欄與合計為 0 時不顯示） |
| 欄身 | 卡片垂直排列、間距 `--space-2`；欄內捲動，捲動時欄首下緣出現 1px `--color-border-subtle` |
| 欄尾 | `QuickAdd fullWidth`，placeholder「新增任務…」 |

| 狀態 | 表現 |
|---|---|
| 空欄 | 欄身顯示高 72 的虛線框（1px dashed `--color-border`、`--radius-md`），文字「拖曳卡片到這裡」`--text-xs` text-tertiary |
| 拖曳經過（可放置） | 容器底改 `--color-surface-active`；空欄虛線框邊改 `--color-border-strong` |
| 長欄 | 每欄先渲染 50 張，其後 ghost 鈕「顯示其餘 N 筆」（點一次全展開；拖曳經過時自動展開） |
| 被篩選排除 | FilterBar 有選 `status` 時只渲染被選取的欄 |

### 3.2 KanbanCard

```
┌────────────────────────────────────┐
│ ● 預設專案                    [📌] │ ← 專案列：專案數 > 1 才顯示；右上為 PinButton 插槽
│ 設計登入頁版面與錯誤狀態            │ ← 標題 --text-sm 500，最多 3 行，超出以 … 截斷
│ (王)  📅 11/28   ⏱ 6h     3 小時前 │ ← 中繼列：Avatar sm · 到期日 · 預估工時 · UpdatedAt（靠右）
└────────────────────────────────────┘
```

- 容器：`--color-surface`、1px `--color-border`、`--radius-md`、`--shadow-xs`、內距 `--space-3`、列間距 `--space-2`。
- 專案列：6px 色點（`--color-tag-*`）+ 專案名 `--text-xs` text-tertiary，單行截斷。
- 中繼列：圖示 16px text-tertiary；文字 `--text-xs` text-secondary、tabular-nums；項目間距 `--space-3`。
  - 負責人：`Avatar sm`；未指派用 Avatar 的未指派樣式。
  - 到期日：`MM/DD`（跨年 `YYYY/MM/DD`）；無值不顯示。逾期（早於今天且 category ≠ done）→ `--color-status-overdue-soft` 底 + `--color-status-overdue-text` 字的小膠囊；今天到期 → 文字「今天」、`--color-warning-text`；done 類欄一律一般色。
  - 預估工時：`6h`（小數最多一位）；無值不顯示。`UpdatedAt`（`at=updated_at`、`by=updated_by`）：永遠顯示、靠右。
- `PinButton`：固定在卡片右上（無專案列時浮於標題右上，標題保留 28px 右內距）；core 版回傳 null 時不佔位；點擊不得觸發開啟詳情或拖曳。

| 狀態 | 表現 |
|---|---|
| 預設 | 如上，`cursor: pointer` |
| hover | 邊框 `--color-border-strong` |
| focus-visible | core 共通 focus outline |
| 選取（任務正開啟於 TaskDrawer） | 邊框 `--color-accent`、底 `--color-accent-soft` |
| 拖曳中 — 原位 | 等高佔位框：1px dashed `--color-border-strong`、內容隱藏 |
| 拖曳中 — 浮層 | 與卡片同寬、`--shadow-sm`、`cursor: grabbing`；不旋轉、不縮放 |
| 儲存中 | 樂觀更新，立即呈現新位置，不顯示載入指示 |
| 儲存失敗 | 卡片回到原欄原位 + 錯誤提示列（§4.4） |

無停用狀態（所有成員皆可拖曳）。

### 3.3 頁面層級狀態

| 狀態 | 表現 |
|---|---|
| 首次載入 | 4 個骨架欄，每欄 3 張 `Skeleton` 卡（高 84） |
| 載入失敗 | `ErrorState`（「載入失敗」+ 訊息 +「重試」） |
| 無任何任務 | 各欄照常顯示（空欄提示 + QuickAdd） |
| 篩選後無結果 | core §6.2：`EmptyState`「沒有符合條件的任務」+「清除篩選」，不渲染欄 |
| 背景更新 | 輪詢 / focus 重抓靜默套用；**拖曳進行中暫緩套用，放下後再套用** |

## 4. 互動流程

### 4.1 點擊與拖曳
指標感應器啟動距離 6px：未達即放開 = 點擊 → `openTask(id)`；觸控長按 200ms 啟動拖曳。抽屜開啟時看板仍可操作（core §7.2 無遮罩），點另一張卡片即切換抽屜內容。

### 4.2 拖曳排序與改狀態
1. 拿起：原位變佔位框，浮層跟隨指標；其他卡片以 `--duration-base` `--ease-standard` 讓位。
2. 經過其他欄：該欄套「拖曳經過」樣式，佔位框移到預計落點；靠近看板左右邊緣或欄身上下邊緣時自動捲動。
3. 放下：同欄只更新 `sort_order`；跨欄以同一個 PATCH 送 `status_id` + `sort_order`。
   - `sort_order` 取落點前後兩張卡的中間值；欄首取「首張 − 1」、欄尾取「末張 + 1」、空欄取 0；前後鄰居以**目前可見的卡片**計算（有篩選時亦然）。
   - 欄首計數與 Σ 工時隨樂觀更新立即變動。
4. 放在看板外或按 `Esc`：取消，回原位，不送請求。
5. `prefers-reduced-motion` 下動畫時長歸 0；進階動畫留給 T9。

### 4.3 欄尾快速新增
- `QuickAdd` 的 `defaults`：`status_id` = 該欄狀態；FilterBar 恰好只選一個專案時帶 `project_id`；恰好只選一位負責人（非「未指派」）時帶 `assignee_id`；另帶 `sort_order` = 該欄末張 + 1，使新卡片落在欄底。
- 建立成功：新卡片出現在欄底並將欄身捲到底；輸入框保持 focus 可連續新增。
- 新任務不符合目前篩選而未出現時：輸入框下方顯示 `--text-xs` text-secondary「已建立，但不符合目前篩選」+ 連結「清除篩選」，6 秒後消失。

### 4.4 錯誤提示列（T9 的 toast 上線前使用）
看板容器上方、滿寬，樣式同 core §5 提示列（danger 的 `-soft` 底、`-border` 邊、`-text` 字），`role="alert"`。文案「無法更新『<任務標題>』，已還原。」+ ghost 鈕「重試」+ 關閉鈕；8 秒後自動消失，同時只顯示最新一則。

## 5. 鍵盤操作

卡片採 **roving tabindex**：整個看板只有一張卡片在 Tab 順序內；`Tab` 順序為 FilterBar → 看板（目前卡片）→ 各欄 QuickAdd（由左至右）。

| 情境 | 按鍵 | 作用 |
|---|---|---|
| 瀏覽 | `↑` / `↓` | 同欄上一張 / 下一張 |
| 瀏覽 | `←` / `→` | 移到相鄰欄中位置最接近的卡片（空欄跳過） |
| 瀏覽 | `Home` / `End` | 該欄第一張 / 最後一張 |
| 瀏覽 | `Enter` | `openTask(id)` 開啟任務詳情 |
| 瀏覽 | `Space` | 拿起卡片（進入拖曳模式） |
| 瀏覽 | `A` | 聚焦目前欄的 QuickAdd |
| 拖曳中 | `↑` / `↓` | 在欄內上移 / 下移一格 |
| 拖曳中 | `←` / `→` | 移到相鄰欄相近位置（空欄落在欄首） |
| 拖曳中 | `Space` | 放下並儲存 |
| 拖曳中 | `Esc` | 取消並回原位（優先於 core 的 Esc 關閉抽屜） |

- 使用 dnd-kit `KeyboardSensor` + `sortableKeyboardCoordinates`；啟動鍵只設 `Space`（`Enter` 保留給開啟詳情）。
- 鍵盤拖曳時，被拿起的卡片維持 focus outline 並加 `--shadow-sm`；目標欄套「拖曳經過」樣式並捲入視野；此時停用 core §8 的全域快捷鍵（`N`、`/`、`G` 序列、`[`）。
- 語意：看板 `role="region" aria-label="任務看板"`；每欄 `role="group"` 並以欄名標示；欄身 `role="list"`、卡片 `role="listitem"`。
- 卡片 `aria-label`：「<標題>，負責人 <姓名或未指派>，到期 <日期或無>，預估 <N 小時或未估>」；`aria-roledescription="可拖曳的任務卡片"`；`aria-describedby` 說明「按空白鍵拿起，方向鍵移動，再按空白鍵放下，Esc 取消」。
- 即時播報（`aria-live="assertive"`）：拿起「已拿起『<標題>』，目前在 <欄名> 第 n 張，共 m 張」；移動「移到 <欄名> 第 n 張」；放下「已放到 <欄名> 第 n 張」；取消「已取消，回到 <欄名> 第 n 張」。

## 6. 響應式

| 寬度 | 版面 |
|---|---|
| ≥ 1280px | 欄寬 288，四欄可完整並列；TaskDrawer 開啟後可視寬度縮減，以水平捲動補足 |
| 1024–1279px | 欄寬 272；Sidebar 收合時四欄可並列，否則水平捲動 |
| 768–1023px | 欄寬 264、內容內距 `--space-4`；水平捲動加 `scroll-snap-type: x proximity`（每欄 `scroll-snap-align: start`）；卡片中繼列可換成兩行（UpdatedAt 落到第二行靠右）；QuickAdd 與「顯示其餘 N 筆」高度 ≥ 36px；TaskDrawer 依 core 視為 modal |
| < 768px | 不在支援範圍：欄寬 `calc(100vw - 48px)` 水平滑動，僅需不產生頁面層級水平捲軸 |

## 7. 待實作者確認

`POST /api/tasks` 與 `QuickAdd` 的 `defaults` 是否接受 `sort_order`、`assignee_id`；若不接受，改為建立後補一次 PATCH，畫面行為不變。

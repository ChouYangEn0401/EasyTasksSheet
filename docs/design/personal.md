# 設計規格 — feat/personal（T5，輕量）

適用路由 `/me` 與插槽元件 `features/personal/PinButton.tsx`。token 與基礎元件一律引用 `core-shell.md`，本文件不新增色碼、尺寸變數或 `src/web/ui` 元件。

## 1. 版面線框（≥ 1280px）

```
┌ 內容區（內距 --space-6）──────────────────────────────────────────────────┐
│ [ⓘ 正在檢視 王小明 的清單（唯讀）  回到我的清單]      檢視：(頭) 我自己 ▾ │
│ ┌ 指派給我的任務  5 ──── ☐ 顯示已完成 ┐  ┌ 自由待辦  3 ───────────────┐ │
│ │ ● 進行中  撰寫週報   ●預設 11/28 3時前 🔖│  │ [+ 新增待辦，按 Enter 建立 ] │ │
│ │ ● 待辦    校正儀器   ●預設 12/02 昨天 🔖│  │ ⠿ ☐ 訂購試劑       2 時前 ✕│ │
│ └──────────────────────────────────────┘  │ ⠿ ☐ 回覆審稿意見   昨天   ✕│ │
│ ┌ 我標記的任務  2 ─────────────────────┐  │     └ 週五前要寄出            │ │
│ │ ● 審查中  資料清理 (頭) ●預設 — 2天前 🔖│  │ ▸ 已完成 4        清除已完成 │ │
│ └──────────────────────────────────────┘  └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────┘
   左欄 flex: 1（兩區上下堆疊，間距 --space-6）          右欄 360px
```

- 三區皆為卡片：`--color-surface`、1px `--color-border`、`--radius-lg`。區塊標題列高 48、內距 0 16、下緣 border-subtle：標題 `--text-lg` 600 + 計數 Badge（neutral、`--radius-full`），右側為該區控制項。
- 頁首列：右側成員切換 `Select`（選項帶 Avatar，第一項固定「我自己」）；唯讀提示列只在檢視他人時出現。

## 2. 任務列（指派給我 / 我標記的，共用 TaskRow）

列高 `--row-height`、內距 0 16、以 `--color-border-subtle` 分隔。由左至右：
`StatusBadge`（唯讀）→ 標題（`--text-sm`，flex: 1，單行截斷）→ 負責人 Avatar `xs`（僅「我標記的」區顯示）→ 專案色點 + 名稱（text-secondary，寬 < 1280 時只留色點）→ 到期日（`--text-xs` tabular-nums，無則「—」）→ `<UpdatedAt>` → `PinButton`。

| 狀態 | 呈現 |
|---|---|
| 預設 | 如上 |
| hover | `--color-surface-hover` 底、游標 pointer |
| focus-visible | 標準 focus outline（內縮 2px） |
| 逾期未完成 | 到期日用 `--color-status-overdue-text` |
| 已完成（category=done） | 標題 text-tertiary + 刪除線 |

- 點擊列（PinButton 以外）→ `openTask(id)`。
- **指派給我**：預設只列未完成，依到期日近→遠（無日期排最後）；勾選「顯示已完成」後已完成接在最後。
- **我標記的**：依標記時間新→舊，含已完成；任務被刪除時該列自動消失。取消標記即樂觀移除該列，不需確認。

## 3. 自由待辦

### 3.1 新增列
區塊頂部 `Input` md 滿寬（外距 12 16），前置「+」圖示。Enter 建立 → 清空並保持 focus，新項目加在未完成清單**最上方**；空白無作用；Esc 清空失焦。送出中 / 失敗呈現比照 core QuickAdd §7.1。

### 3.2 待辦列（TodoRow）
```
 ⠿  ☐  訂購試劑                         2 小時前  ✎  ✕
        └ 備註文字（--text-xs text-secondary，最多 2 行）
```
- 最小高 `--row-height`、內距 0 12；`⠿` 拖曳把手、`✎` 備註、`✕` 刪除皆為 iconOnly ghost sm，**僅 hover / focus-within 顯示**（把手 text-tertiary、游標 `grab`）。
- 標題就地編輯：點標題或 `Enter` → 變為 readonly 樣式轉一般 Input；Enter / 失焦儲存，Esc 取消；清空後儲存視為無效並還原。
- 備註：`✎` 展開列下方 Textarea（2 列），失焦儲存；有備註時常駐顯示於標題下。
- 勾選：Checkbox 立即切換；完成的項目移入底部「已完成」群組。
- 刪除：`✕` 立即刪除、不確認（輕量內容）。

| 狀態 | 呈現 |
|---|---|
| 預設 / hover | 透明 / `--color-surface-hover`，顯示把手與動作鈕 |
| 編輯中 | 標題為 Input（accent 邊框 + focus ring） |
| 拖曳中（原位） | `opacity: .4`；插入位置顯示 2px accent 橫線 |
| 拖曳浮層 | surface 底、border、`--radius-md`、`--shadow-sm` |
| 已完成 | Checkbox 勾選、標題 text-tertiary + 刪除線、無把手 |
| 儲存失敗 | 還原內容，列下方 `--text-xs` danger-text「儲存失敗，請再試一次」 |

### 3.3 已完成群組
清單底部收合列（高 32）：chevron +「已完成 N」text-secondary；**預設收合**，不可排序。右側「清除已完成」ghost sm → 確認 Dialog `sm`「刪除 N 筆已完成的待辦？」主要鈕 `danger`。N = 0 時整列不顯示。

## 4. PinButton（插槽升級）

- 簽名：`<PinButton taskId size?="sm" | "md" />`；`iconOnly` ghost Button，書籤圖示 16px，`sm` = 28、`md` = 32。
- 資料：全站共用一個「我的標記」查詢（同一 query key），所有 PinButton 讀同一份、樂觀更新；**永遠反映登入者自己的標記**（即使在檢視他人清單）。
- 點擊呼叫 `PUT` / `DELETE /api/personal/pins/:taskId`，並 `stopPropagation`，不觸發所在列 / 卡片的點擊或拖曳。

| 狀態 | 呈現 | 無障礙 |
|---|---|---|
| 未標記 | 線條書籤、`--color-text-tertiary` | `aria-pressed="false"`、label「加入我的標記」 |
| 未標記 hover | `--color-surface-hover` 底、`--color-text` | tooltip 同 label |
| 已標記 | 實心書籤、`--color-accent` | `aria-pressed="true"`、label「移出我的標記」 |
| 已標記 hover | `--color-accent-soft` 底、`--color-accent-hover` | tooltip 同 label |
| focus-visible | 標準 focus outline | — |
| 寫入中 | 顯示樂觀結果，暫不接受再次點擊 | `aria-busy` |
| 失敗 | 還原圖示；tooltip 改為「標記失敗，請再試一次」（danger，3 秒） | `aria-live="polite"` |
| 查詢載入中 / 未登入 | 不渲染（回傳 null，不佔位） | — |

- 引用處建議：List 列尾與 Kanban 卡片右上用 `sm`，未標記時可由引用處設為 hover 才顯示、已標記時常駐；TaskDrawer 標題列關閉鈕左側用 `md`、常駐。切換以 `--duration-fast` 過渡填色，不做彈跳動畫。

## 5. 唯讀檢視他人（`/me?user=<id>`）

- 頁首出現 info-soft 提示列（樣式同登入頁提示列）：「正在檢視 王小明 的清單（唯讀）」+ 文字連結「回到我的清單」。
- 區塊標題改為「指派給 王小明 的任務」「王小明 標記的任務」「王小明 的自由待辦」。
- 自由待辦：不渲染新增列、把手、`✎`、`✕`、「清除已完成」；Checkbox 為 disabled 外觀但保留勾選狀態；標題不可編輯。
- 任務列仍可點擊開啟 TaskDrawer；PinButton 照常運作（改的是我自己的標記）。
- 找不到該成員或已停用：EmptyState「找不到這位成員」+「回到我的清單」。

## 6. 空 / 載入 / 錯誤

| 區塊 | 空狀態（EmptyState，不放按鈕） | 載入 | 錯誤 |
|---|---|---|---|
| 指派給我 | 「目前沒有指派給你的任務」 | 3 列 Skeleton | 區塊內 ErrorState + 重試 |
| 我標記的 | 「還沒有標記的任務」，說明「在任務上點書籤圖示即可加入」 | 3 列 Skeleton | 同上 |
| 自由待辦 | 「寫下第一件待辦」，說明「只有你能修改這份清單」 | 新增列 + 3 列 Skeleton | 同上 |

三區各自獨立載入與報錯，互不阻擋；輪詢與 focus 重抓時靜默更新，不閃爍。唯讀檢視的空狀態文案把「你」換成成員名稱，且不顯示操作說明。

## 7. 鍵盤

| 按鍵 | 作用 |
|---|---|
| `C` | 聚焦自由待辦新增列（focus 在輸入框時不觸發；唯讀檢視無效） |
| `Tab` | 成員切換 → 指派給我 → 我標記的 → 自由待辦；列內順序：列本體 → PinButton（任務列）／把手 → Checkbox → 標題 → `✎` → `✕`（待辦列） |
| `↑` `↓` | 在同一區的列之間移動 |
| `Enter` | 任務列：開啟 TaskDrawer；待辦標題：進入 / 儲存編輯 |
| `Space` | PinButton、Checkbox 切換；把手上為拿起 / 放下（dnd-kit 鍵盤感應器），拿起後 `↑` `↓` 移動、`Esc` 取消 |
| `Alt+↑` / `Alt+↓` | 待辦列直接上移 / 下移一格（不需拿起） |
| `Delete` | 刪除目前 focus 的待辦列（非編輯中），focus 移到下一列 |
| `Esc` | 取消編輯 / 取消拖曳 |

- 排序以 `aria-live="assertive"` 播報：「已拿起 訂購試劑，位置 2 / 5」「已移到位置 1」「已取消」。
- 刪除與取消標記後 focus 落在下一列；該區已空則落在新增列或區塊標題。

## 8. 響應式

| 寬度 | 版面 |
|---|---|
| ≥ 1280px | 兩欄：左欄任務兩區堆疊、右欄自由待辦 360px（隨頁面捲動，不固定） |
| 1024–1279px | 兩欄，右欄 320px；任務列的專案只留色點（tooltip 顯示名稱） |
| 768–1023px | **單欄堆疊**，順序：指派給我 → 我標記的 → 自由待辦；任務列隱藏專案欄；把手、`✎`、`✕` 改為常駐顯示（觸控無 hover），點擊目標 ≥ 36px；長按 250ms 啟動拖曳 |
| < 768px | 不支援；單欄且不產生水平捲軸，任務列再隱藏 `<UpdatedAt>` 以外的次要欄位之前先截斷標題 |

## 9. 給實作者的檢查清單

1. 三區皆有空 / 載入 / 錯誤三態，每列顯示 `<UpdatedAt>`。
2. 自由待辦可新增、勾選、拖曳排序（含鍵盤）、刪除；重整後順序與完成狀態保留。
3. PinButton 在 List、Kanban、TaskDrawer 引用處皆可切換，且不觸發外層點擊；標記後「我標記的」區不需重整即更新。
4. `/me?user=<id>` 完全唯讀，畫面上找不到任何可修改他人清單的控制項。
5. 1280px 與 768px 無水平捲軸；所有顏色皆取自 core token。

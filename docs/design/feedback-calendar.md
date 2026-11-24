# 設計規格 — feat/feedback-calendar（T4）

適用路由 `/feedback`（清單與月曆同頁）。token 與基礎元件一律引用 `core-shell.md`，本文件不新增色碼、尺寸變數或 `src/web/ui` 元件；本軌道需要的組合元件（分段切換、月曆格、項目卡）放在 `features/feedback/`、`features/calendar/` 內。

## 1. 版面線框（≥ 1280px）

```
┌ 內容區（內距 --space-6）────────────────────────────────────────────────────┐
│ ┌ 清單面板 360px ───────────┐  ┌ 月曆面板（flex: 1）──────────────────────┐ │
│ │ [+ 新增問題或回饋… [問題▾]]│  │ ‹  2026 年 11 月  ›  [今天]  ☐ 顯示任務到期日│ │
│ │ (全部|問題|回饋)  [狀態 ▾] │  ├────┬────┬────┬────┬────┬────┬────┤ │
│ │───────────────────────────│  │ 一 │ 二 │ 三 │ 四 │ 五 │ 六 │ 日 │ │
│ │ ▾ 未排程  4               │  ├────┼────┼────┼────┼────┼────┼────┤ │
│ │ ┌───────────────────────┐ │  │ 23 │(24)│ 25 │ 26 │ 27 │ 28 │ 29 │ │
│ │ │○ [問題] 離心機溫度異常 ⋯│ │  │    │▍離心│    │▍採購│    │    │    │ │
│ │ │  (頭) 王小明 · 3 小時前 │ │  │    │▍週報│    │☐ 任務│    │    │    │ │
│ │ └───────────────────────┘ │  │    │+2 更多│   │    │    │    │    │ │
│ │ ▾ 已排程  3  ▸ 已解決  12 │  │ …  │    │    │    │    │    │    │ │
│ └───────────────────────────┘  └────┴────┴────┴────┴────┴────┴────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

- 兩面板皆 `--color-surface`、1px `--color-border`、`--radius-lg`，間距 `--space-6`，高度填滿內容區；清單面板內部垂直捲動，新增列與篩選列固定在面板頂部。頁面級提示列（寫入失敗時）出現在兩面板上方，樣式同登入頁提示列。

## 2. 清單面板

### 2.1 新增列
- `Input` md + 尾端類型 `Select`（問題 / 回饋，預設沿用上次選擇）。placeholder「新增問題或回饋，按 Enter 建立」。
- Enter 建立（`title` + `kind`，`reporter_id` = 自己）→ 清空並保持 focus；空白無作用；Esc 清空失焦。送出中 / 成功 / 失敗的呈現比照 core QuickAdd §7.1。新項目出現在「未排程」群組最上方。

### 2.2 篩選列
- 類型：三段分段切換（`全部｜問題｜回饋`），高 `--control-sm`，容器 `--color-surface-active` 底、`--radius-md`；選取段為 surface 底 + `--shadow-xs` + `--color-text`，未選為 text-secondary，hover 轉 text。
- 狀態：多選 `Select`（未排程 / 已排程 / 已解決），外觀與已設定樣式同 FilterBar §6.2。
- 狀態存 URL：`kind`、`status`（逗號分隔）、`month=YYYY-MM`。篩選**同時作用於清單與月曆**。有篩選時列尾顯示「清除」ghost 鈕。

### 2.3 群組
- 依狀態分三群：未排程（建立時間新→舊）、已排程（排程日近→遠）、已解決（更新時間新→舊，**預設收合**）。
- 群組標題列高 32：chevron + 名稱 `--text-sm` 600 text-secondary + 計數 Badge（neutral、`--radius-full`）。點擊或 Enter 收合 / 展開，`aria-expanded`。空群組仍顯示標題與「—」。

### 2.4 項目卡（FeedbackCard）
```
┌──────────────────────────────────────────┐
│ ○  [問題] 離心機溫度讀數異常          ⋯ │  ← 標題 --text-sm 500，最多 2 行
│    (頭像xs) 王小明 · 📅 11/28 · 3 小時前 │  ← --text-xs text-tertiary
└──────────────────────────────────────────┘
```
- 卡片：surface、1px border、`--radius-md`、內距 10 12、卡間距 `--space-2`、左右外距 `--space-3`。
- 左：解決圈（16px 圓形勾選鈕，一次點擊標記已解決 / 重新開啟；`aria-label` 隨狀態切換）。
- 類型 Badge：問題 = tag `orange`、回饋 = tag `blue`。
- 第二列：負責人 Avatar `xs` + 名稱（未指派顯示虛線頭像 +「未指派」）、排程日（僅已排程；早於今天且未解決用 `--color-status-overdue-text`）、`<UpdatedAt>`。
- 右：`⋯` iconOnly ghost（hover / focus-within 才顯示）→ Menu：編輯、排入日期…、取消排程（已排程才有）、標記已解決 / 重新開啟、刪除（danger-text）。

| 狀態 | 呈現 |
|---|---|
| hover | border `--color-border-strong`、游標 `grab` |
| focus-visible | 標準 focus outline |
| 拖曳中（原位） | `opacity: .4`，保留佔位 |
| 拖曳浮層 | 同卡片樣式、寬度固定 280、`--shadow-sm`、游標 `grabbing` |
| 已解決 | 標題 text-tertiary + 刪除線、解決圈為 success 底白勾、**不可拖曳** |

### 2.5 整體狀態（清單與月曆）
- 載入：清單為 3 個群組標題 + 6 張卡片 Skeleton；月曆格立即渲染，當月 4–5 格放 chip Skeleton。
- 空（完全無資料）：清單 EmptyState「還沒有問題或回饋」，說明「在上方輸入框新增第一筆」；月曆不另放 EmptyState。
- 尚無任何已排程項目時，月曆下緣顯示一行 `--text-xs` text-tertiary「把左側項目拖到日期上即可排程」。
- 篩選後空：EmptyState「沒有符合條件的項目」+「清除篩選」。
- 錯誤：清單顯示 ErrorState + 重試；月曆面板維持空白月曆格。

## 3. 月曆面板

### 3.1 標題列（高 48、內距 0 16、下緣 border-subtle）
- `‹` `›` iconOnly ghost（`aria-label`「上個月」「下個月」）、月份標題 `--text-lg` 600（`2026 年 11 月`，`aria-live="polite"`）、「今天」secondary sm（已在本月且今天可見時停用）。
- 右側 Checkbox「顯示任務到期日」（預設勾選，存 `localStorage`）。**次要功能，可延後**；延後時整個選項不渲染。

### 3.2 月曆格（MonthGrid）
- 7 欄等寬，**週一起始**（常數 `WEEK_STARTS_ON = 1`，可調）；星期列高 28、`--text-xs` 500 text-tertiary 置中。
- 依當月需要渲染 4–6 週，各列等高均分剩餘高度，單格最小高 96px；格線 1px `--color-border-subtle`。
- 日期數字在格內左上（內距 6 8），`--text-xs` 500、tabular-nums。

| 日格狀態 | 呈現 |
|---|---|
| 一般 | surface 底、數字 text-secondary |
| 週末 | 底 `--color-bg` |
| 非本月 | 底 `--color-bg`、數字 `--color-text-disabled`，項目照常顯示且可放置 |
| 今天 | 數字為 20px accent 實心圓 + `--color-text-on-accent`，`aria-current="date"` |
| 鍵盤游標 | 格內 2px accent 內框 |
| **放置目標**（拖曳懸停；其餘日格拖曳中無變化） | `--color-accent-soft` 底 + 2px accent 內框 |

### 3.3 日格內項目（CalendarChip）
- 高 22、`--radius-sm`、內距 0 6、`--text-xs`、單行截斷；格內垂直堆疊間距 2px。左緣 3px 色條。
- 問題：`--color-tag-orange-soft` 底 + orange 色條；回饋：`--color-tag-blue-soft` 底 + blue 色條；文字 `--color-text`。
- 已解決：`--color-surface-active` 底、text-tertiary、刪除線、不可拖曳。
- hover：加 1px 同色 border、游標 `grab`；focus-visible：標準 outline；拖曳中原位 `opacity: .4`。
- Tooltip（hover / focus）：完整標題 · 負責人 · `更新於 …`（以此滿足「每個項目顯示最後更新」）。
- 每格最多顯示 3 個，其餘收為「+N 更多」文字鈕（`--text-xs` accent-text）→ Popover（寬 260，Menu 面板樣式）列出該日全部項目，列內含類型 Badge、標題、`<UpdatedAt>`；Popover 內項目同樣可拖出。
- **任務到期日 chip**（唯讀）：透明底、1px `--color-border`、text-secondary、前置 12px 勾選框圖示；已完成加刪除線；逾期未完成用 `--color-status-overdue-text`。排在回饋項目之後，點擊 `openTask(id)`，不可拖曳、不是放置來源。

## 4. 編輯 Dialog（`md`）

- 開啟：點卡片 / chip 本體，或 Menu「編輯」。標題「編輯問題」/「編輯回饋」。
- 欄位：類型（分段切換）、標題（必填）、內容（Textarea，6 列）、負責人（Select，含未指派）、排程日（`<input type="date">` 套 Input 樣式，可清除）、狀態（唯讀 Badge：未排程 neutral / 已排程 accent / 已解決 success）。
- 頁尾左側：`回報者 王小明 · <UpdatedAt prefix="更新於" by>`；左下「刪除」ghost danger-text；右側「取消」「儲存」。未變更時「儲存」停用；儲存中按鈕 loading；API 錯誤顯示在表單上方 danger-soft 提示列。刪除：另開確認 Dialog `sm`「刪除這筆問題？此動作無法復原。」，主要鈕 `danger`。
- 「排入日期…」Menu 項：開啟僅含日期欄的小 Popover（日期輸入 +「排入」primary sm），是**拖曳的非指標替代路徑**。

## 5. 互動流程

狀態規則（建議由後端依 `scheduled_date` 推導，前端只送改動欄位）：

| 動作 | 寫入 | 結果狀態 |
|---|---|---|
| 清單卡片拖到某日 | `scheduled_date = D` | 已排程 |
| chip 在日期間拖曳 | `scheduled_date = D'` | 已排程（改期） |
| chip 拖回清單面板 | `scheduled_date = null` | 未排程 |
| 標記已解決 | `status = resolved`（保留排程日） | 已解決 |
| 重新開啟 | `status` 依有無排程日回到已排程 / 未排程 | — |

- 拖曳啟動：指標移動 6px 後啟動（避免誤觸點擊）；整張卡片 / chip 皆為把手。同一個 dnd-kit context 涵蓋清單、月曆與「+N」Popover。
- 拖曳 chip 時，清單面板整體成為放置區：覆上 `--color-accent-soft` 半透明層 + 2px 虛線 accent 邊框，中央文字「放開以取消排程」。拖曳清單卡片時清單面板不反應。
- 放在原日期或無效區域：浮層以 `--duration-base` 回到原位，不送請求。樂觀更新：放下即移動；失敗則還原並在頁面頂部顯示 danger-soft 提示列「排程未儲存，已還原」+「重試」（T9 前不依賴 Toast）。
- 拖曳靠近月曆面板上下緣不換月；需跨月時先切月再拖，或使用「排入日期…」。切月：`‹ ›` 與「今天」更新 `month` 參數（`replace`），格內容以 `--duration-base` 淡入；`prefers-reduced-motion` 時無動畫。

## 6. 鍵盤

| 按鍵 | 作用 |
|---|---|
| `C` | 聚焦新增列（focus 在輸入框時不觸發；不佔用全域 `N`） |
| `Tab` | 新增列 → 篩選 → 清單卡片（逐張）→ 月曆標題列 → 月曆格（單一 tab stop，roving tabindex） |
| `↑` `↓`（清單內） | 在卡片間移動，跨群組連續 |
| `Enter`（卡片 / chip） | 開啟編輯 Dialog |
| `R` / `S` / `U` | focus 在卡片或 chip 時：標記已解決或重新開啟 / 開啟「排入日期…」Popover / 取消排程 |
| `Space` | 拿起項目（dnd-kit 鍵盤感應器）；再按一次放下；`Esc` 取消 |
| 拿起後 `←` `→` / `↑` `↓` | 目標日 ±1 天 / ±7 天；自清單拿起時第一下方向鍵落在今天（今天不在本月則為當月 1 日）；超出本月自動換月 |
| 拿起後 `Home` | 目標移到清單（= 取消排程） |
| `←` `→` `↑` `↓`（月曆格、未拿起） | 移動日期游標；`Enter` 進入該格第一個 chip，`Esc` 回到日格 |
| `PageUp` / `PageDown` / `T` | 上個月 / 下個月（focus 在月曆內）/ 回到今天 |

- 月曆格 `role="grid"`，日格 `role="gridcell"` 並帶 `aria-label="11 月 24 日 星期二，2 個項目"`；拖曳全程以 `aria-live="assertive"` 播報：「已拿起 離心機溫度異常」「目標 11 月 26 日」「已排入 11 月 26 日」「已取消排程」「已取消」。

## 7. 響應式

| 寬度 | 版面 |
|---|---|
| ≥ 1280px | 清單 360px + 月曆，如線框 |
| 1024–1279px | 清單 300px；日格最多顯示 2 個 chip；月份標題列的 Checkbox 文字縮為「任務到期日」 |
| 768–1023px | **上下堆疊**：清單面板在上（高 280px，內部捲動，標題列可收合為 44px），月曆在下滿寬、日格最小高 80px、最多 2 個 chip。拖曳時頁面自動捲動；拖曳 chip 時於 Header 下緣固定浮出高 48 的「放開以取消排程」放置列（`--z-header`），免捲回清單 |
| < 768px | 不支援；月曆面板內部水平捲動（最小寬 560px），不撐破 shell |

- 觸控：長按 250ms 啟動拖曳；chip 與解決圈點擊目標 ≥ 28px（768px 時解決圈含內距 36px）。
- 驗收提醒：排入 / 改期 / 取消排程皆須有非拖曳路徑（Menu、`S`、`U`、Dialog 排程日）；重整後排程、`month` 與篩選保留；卡片與 Popover 列顯示 `<UpdatedAt>`，chip 於 tooltip、Dialog 於頁尾顯示。

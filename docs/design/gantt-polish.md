# 設計規格 — 甘特圖改版（gantt-polish）

適用：`src/web/features/gantt/`（`Gantt.tsx`、`gantt.css`、`timeline.ts`、`GanttPage.tsx`）。本文件**覆寫** `gantt-overview.md` §A2–A4、§D 中與下列條目衝突的部分；未提及者（拖曳、鍵盤改日期、Popover、儲存失敗）照舊。色彩一律用 `core-shell.md` §2 的 token 與既有的 `--status-soft / --status-dot / --status-text`（`statusStyle(tone)`），不新增色碼；尺寸可在 `.gantt` 內宣告區域變數。

## 0. 目標線框

```
 ┌───────────────────────┬──────────────────────────────────────────────────────────────────┐
 │                       │ 2026 年 11 月                    │ 2026 年 12 月                  │ ← 上層 28px
 │ 任務             起訖 │ 11/16    │ 11/23  [今天] │ 11/30    │ 12/7     │ 12/14    │ …    │ ← 下層 24px
 ├───────────────────────┼──────────────────────●───────────────────────────────────────────┤
 │ ▾ (暘) 暘恩  1        │          ░░        ├─┤░░        ░░        ░░                     │ ← 群組列
 │   ● ntu ranking… 11/24–11/26 │   ░░   ▓▓▓ ntu ranking new workflow · 40%                 │ ← 窄長條 + 右側標題
 ├───────────────────────┴──────────────────────────────────────────────────────────────────┤
 │ 無排程任務（1）  (管) 管理員 · 未排程 1                                                    │ ← 空分組摘要列
 ├───────────────────────┬──────────────────────────────────────────────────────────────────┤
 │ ▾ 未排程  1           │                              尚未設定日期，不會出現在時間軸        │
 │   ● pyDMS             │ (未指派)  更新於 2 分鐘前                            [排入日期]   │
 └───────────────────────┴──────────────────────────────────────────────────────────────────┘
```

## 1. 時間軸範圍（`computeRange`）

簽名改為 `computeRange(tasks, today, scale, minDays = 0)`，`minDays = ceil(可視時間軸寬 / dw)`（可視寬 = 捲動容器 `clientWidth − 左欄寬`，以 `useLayoutEffect` 首次量測 + `ResizeObserver` 更新）。

| 刻度 | 每日寬 `dw` | 前邊界 `lead` | 後邊界 `tail` = `ceil(240 / dw)` |
|---|---|---|---|
| 日 | 32px | 3 天 | 8 天 |
| 週 | **16px**（每週 112px，原 12px） | 7 天 | 15 天 |
| 月 | 4px | 31 天 | 60 天 |

計算順序（每步都做）：
1. `start = min(最早開始日, 今天) − lead`；`end = max(最晚到期日, 今天) + tail`（後邊界保證長條右側標題不被裁切）。
2. 對齊：日 / 週刻度對齊整週（週一起）、月刻度對齊整月。
3. **填滿**：若 `end − start < minDays`，或 `end < 今天 + ceil(minDays × 2/3)`（確保「今天在左側 1/3」可成立），把 `end` 以整週 / 整月為單位往後延伸到兩個條件都滿足。只延伸、不壓縮 `dw`。
4. 容器變寬時只重算並延伸；沿用現有「範圍變動時保持可視中心日期」邏輯。拖曳中不重算範圍。

CSS 保險（量測前也不留白）：`.gantt-inner{min-width:100%}`；`.gantt-head-time, .gantt-cell-time{flex:1 0 var(--gantt-total)}`；`.gantt-overlay{right:0;width:auto}`；`.gantt-cell-time{overflow-x:clip}`。

**預設刻度**：優先序 URL `scale` > `localStorage['gantt.scale']`（使用者手動切換時寫入）> 自動。自動規則以「已排程任務最早開始到最晚到期（含今天）」的天數 `span` 判斷：`span ≤ 28` → 日；`≤ 182` → 週；其餘 → 月。自動結果不寫入 URL，但刻度切換鈕要反映實際採用的刻度。精簡版固定週刻度。`timeline.test.ts` 需同步更新（週寬、範圍、新參數）。

## 2. 表頭與格線層次

- 上層列高 28px：`--text-sm` 600 `--color-text`，下緣 1px `--color-border-subtle`，每格左緣 1px `--color-border`。下層列高 24px：`--text-xs` `--color-text-secondary`。表頭總高 52px；`.gantt-head-corner` 同高，內容為「任務」（左）與「起訖」（右），貼齊下層列基線。
- 格線（`.gantt-gridline`）：刻度單位線用 `--color-border-subtle`；**月份邊界**（日 / 週刻度）與**年邊界**（月刻度）改用 `--color-border`，貫穿內容區。日刻度維持每日細線。
- **週末淡底**：日與週刻度都畫（週刻度每週一條 2 × 16 = 32px 的帶），底 `--color-bg`、`opacity:1`、`mix-blend-mode:multiply`（疊在 hover / 群組列底色上仍看得出列狀態）。月刻度不畫。日刻度下層週末格文字改 `--color-text-tertiary`。
- **今天欄淡底**：日與週刻度在今天那 1 天寬畫 `--color-danger-soft` 帶（同樣 multiply）；月刻度不畫。層級：週末帶 < 今天帶 < 格線 < 今日線 < 長條。

## 3. 今天線與標籤（不遮擋刻度）

- 移除絕對定位的 `.gantt-today-pill`。`HeaderCell` 增加 `today?: boolean`（下層列中包含今天的那一格）。
- 週 / 月刻度：該格改為 `display:flex; justify-content:space-between`，左為原刻度文字（`--color-danger-text` 600），右為膠囊「今天」（高 18、內距 0 6px、`--radius-full`、`--color-danger-soft` 底、`--color-danger-text` 字、`--text-xs` 500）。兩者同在版面流中，不會互蓋。格寬不足 84px（被範圍邊界裁切）時只顯示膠囊。
- 日刻度（格寬 32px）：不放膠囊，該格整格 `--color-danger-soft` 底、文字 `--color-danger-text` 600。
- 今日線：1.5px `--color-danger`，自內容區頂端貫穿到底；頂端加直徑 7px 實心圓點（壓在表頭下緣線上）。線的 z-index **低於長條**（長條與其標題不被切過）。
- **今天不在可視範圍**：在 `.gantt` 內（捲動容器外）疊一顆膠囊按鈕「‹ 今天」或「今天 ›」，垂直位置對齊下層表頭列，貼左欄右側 8px 或容器右側 8px；樣式同上膠囊、高 20；點擊 = `scrollToToday()`；`aria-label="捲動到今天"`。今天回到可視範圍即移除。

## 4. 長條

`--gantt-bar-h` 改 24px（精簡版維持 14px）。寬 `w = (end − start + 1) × dw`，依 `w` 分兩型：

| 型態 | 條件 | 外觀 |
|---|---|---|
| 一般長條 | `w ≥ 24px` | 寬 = `w`；底 `--status-soft` + 1px 內框 `--status-dot`；`--radius-sm` |
| 窄長條 | `w < 24px` | 視覺寬 `max(w, 8px)`、實心 `--status-dot`、`--radius-sm`；以 `::before{inset:-8px}` 擴大點擊區到至少 24px；不畫進度 |

- **標題**（`.gantt-bar-label`，`--text-xs` 500、單行截斷、`pointer-events:none`、`aria-hidden`）：
  - `w ≥ 96px` → 在長條**內**靠左，內距 0 8px，字色 `--status-text`；`w ≥ 140px` 且 `0 < progress < 100` 時右側另顯示 `40%`（tabular-nums）。
  - `w < 96px`（含窄長條）→ 在長條**右側外**，`left: calc(100% + 10px)`、`max-width:220px`、字色 `--color-text-secondary`；`progress > 0` 時接「 · 40%」（`--color-text-tertiary`）。
  - 拖曳中隱藏外側標題（改顯示既有日期浮標）。精簡版：不顯示內側標題，只有窄長條顯示外側標題。
- **進度**：取消整高填色，改為長條底部 3px 進度帶（`--status-dot`，寬 = `progress`%，左下圓角跟隨長條）；`progress = 0` 不畫。`category = done`：不畫進度帶，內側標題前加 12px 勾勾圖示；窄長條維持實心。
- **逾期**（到期日 < 今天且非 done）：內框改 `--color-status-overdue`，保留右端 3px 色蓋；標題後接「 · 逾期 N 天」（`--color-status-overdue-text`；內側標題僅 `w ≥ 200px` 時顯示）。
- **只有單一日期**：1 天寬，改為 `--color-surface` 底 + 1.5px dashed `--status-dot`（窄長條時視覺寬固定 10px）；標題規則同上。
- **把手**：`w ≥ 24px` 維持條內兩端各 6px；`w < 24px` 把手移到條外（`left:-8px` / `right:-8px`，各 8px 寬，hover 列時顯示），本體整塊為平移。外側標題的 10px 間距即為右把手留位。
- **Tooltip** 增加末行「更新於 3 小時前 · 由 王小明」（原左欄 `UpdatedAt` 的資訊移到這裡）。
- hover：長條內框加粗為 2px；鍵盤 focus 該列時長條加 `outline: 2px solid var(--color-accent); outline-offset: 2px`。

## 5. 左欄（任務列）

- 內容由左至右：狀態色點（8px 圓，`--status-dot`，hover tooltip 為狀態名稱）→ 標題（`--text-sm`，單行截斷，`flex:1`）→ **日期區間**（靠右，`--text-xs` `--color-text-tertiary` tabular-nums）。
- 日期格式：`11/24–11/26`；同一天 `11/24`；只有到期日 `到期 11/26`；只有開始日 `開始 11/24`；年份與今年不同時加年 `2027/1/4`。逾期時整段改 `--color-status-overdue-text`，tooltip「已逾期 N 天」；**移除**標題後的「逾期」Badge。
- **移除**左欄的 `UpdatedAt` 與表頭「更新」字樣（「剛剛」在此無語境；改放 Tooltip 與 TaskDrawer）。
- 列高維持 `--row-height`；分組時縮排 `--space-6`。點擊整格仍為 `openTask(id)`。

## 6. 分組標頭

- 左欄：chevron → `Avatar sm`（專案分組為色點）→ 名稱 `--text-sm` 600 → 計數 Badge（neutral，tooltip「N 筆已排程任務」）→ 靠右：群組內有逾期時顯示 `danger` Badge「逾期 N」。底 `--color-bg`。
- 時間軸側（展開）：2px `--color-border-strong` 起訖線，兩端加 2 × 8px 端蓋。
- 時間軸側（**收合**）：改畫每個任務的摘要條（高 6px、`--radius-full`、`--status-dot`、`opacity:.55`，位置 = 該任務起訖，最小寬 4px），最後一條右側 10px 處標 `N 筆 · 11/20–12/5`（`--text-xs` `--color-text-tertiary`）。
- **沒有已排程任務的分組不再佔整列**，也不再顯示「無排程任務」文字於時間軸。`buildGroups` 回傳不變，`Gantt` 把 `tasks.length === 0` 的 user 群組從列中抽出，集中到**空分組摘要列**（`.gantt-empty-groups`）：
  - 位置：`.gantt` 內、捲動容器之後（不隨水平捲動）；上緣 1px `--color-border-subtle`、底 `--color-bg`、最小高 32px、內距 6px 12px、`flex-wrap`、欄距 `--space-3`。
  - 內容：標籤「無排程任務（N）」`--text-xs` `--color-text-tertiary`，其後每位成員一個項目：`Avatar xs` + 名稱（`--text-xs` `--color-text-secondary`）。
  - 該成員有未排程任務時，項目為按鈕並接「 · 未排程 M」（`--color-accent-text`）；點擊 → 展開未排程區、捲入視野，並把該成員的列以 `--color-accent-soft` 底標示 1.5 秒。`Gantt` 新增 props：`unscheduledCountByAssignee?: Map<number, number>`、`onShowUnscheduled?: (assigneeId: number) => void`。
  - N = 0 時整列不渲染。精簡版同樣採用（覆寫 `gantt-overview.md` §B4「無任務成員在最上」）。

## 7. 捲動行為

- 維持單一捲動容器：表頭 `sticky top`、左欄 `sticky left`。水平捲動量 > 0 時 `.gantt` 加 `is-scrolled-x`，左欄右緣顯示 `box-shadow: var(--shadow-sm)`（以 `clip-path: inset(0 -8px 0 0)` 只露出右側）。
- **進頁自動定位**：今天置於可視寬度左側 1/3（瞬間，不做動畫）。若該視窗內沒有任何長條，改為把「距今天最近的長條」起點置於左側 1/3，今天改由 §3 的邊緣膠囊指示。
- 「今天」鈕與 `T`：`scrollTo({ behavior: 'smooth' })`；`prefers-reduced-motion` 時瞬間。‹ › 仍為一個可視寬度。
- 範圍已填滿且內容不超過容器時不應出現多餘的水平捲軸空白（由 §1 保證總寬 ≥ 可視寬）。

## 8. 未排程區與圖的銜接

- 甘特圖、空分組摘要列、未排程區包在同一個卡片 `.gantt-stack`（1px `--color-border`、`--radius-lg`、`overflow:hidden`）；內部各區塊自身不再有邊框與圓角，區塊間以 1px `--color-border` 分隔，**間距為 0**。
- 標題列：高 36px、底 `--color-bg`；左為 chevron +「未排程」`--text-sm` 600 + 計數 Badge；右為說明「尚未設定日期，不會出現在時間軸」`--text-xs` `--color-text-tertiary`（768–1023px 隱藏）。
- 列（高 40）：**第一欄寬 = `--gantt-left`**，右緣 1px `--color-border`（與上方左欄的分隔線連成一條），內容為狀態色點 + 標題（與上方任務列同樣式、同縮排）；其後 `Avatar sm` + 負責人名稱（`--color-text-secondary`）、`UpdatedAt prefix="更新於"`；最右 secondary `sm`「排入日期」。**移除**此處的 `StatusBadge`（已由色點表示）。
- 「排入日期」Popover：開始日與到期日皆預填今天，可直接按「儲存」。儲存後該列移入圖表並捲到其長條（沿用現行邏輯），長條以 `--color-accent-soft` 列底標示 1.5 秒。
- N = 0 時整區不渲染；超過 10 列時區內捲動。
- **補述（`feat/gantt-unscheduled-drag`）**：列左側（第一欄縮排區內，`left: 6px`）加 20 × 28 拖曳把手（grip 圖示，hover / focus 顯示，< 1024px 與觸控裝置常駐；沒有 `tasks.edit` 或圖表尚無已排程任務時不顯示），可把整列拖到時間軸上排程；互動規則見 `gantt-overview.md` §A7。「排入日期」保留為鍵盤 / 無障礙備案。

## 9. 空狀態

| 情境 | 表現 |
|---|---|
| 沒有任何任務 | `EmptyState`「還沒有任務」+「按 N 快速新增任務」（不變） |
| 有任務但皆未排程 | `.gantt-stack` 上半為 `EmptyState`「尚無已排程的任務」+ 說明「設定開始日與到期日後會顯示在這裡」+ secondary 鈕「查看未排程（N）」（展開並聚焦未排程區標題）；下半未排程區照常 |
| 篩選無結果 | core §6.2 `NoFilterResults`（不變） |
| 載入中 | 骨架沿用，表頭高改 52px，骨架長條高 24px |

## 10. 鍵盤與無障礙

- `gantt-overview.md` §C 全部保留。新增：`U` = 展開未排程區並聚焦其標題列；`T` 改為平滑捲動。
- Tab 順序：樹（單一停駐點）→ 邊緣「今天」膠囊（存在時）→ 空分組摘要列中的按鈕 → 未排程區標題 → 各列的拖曳把手（有 `tasks.edit` 時）、標題與「排入日期」。
- 任務列 `aria-label` 不變（已含起訖、進度、狀態）；逾期時在狀態後加「已逾期 N 天」。長條標題、摘要條、週末 / 今天帶皆 `aria-hidden`。空分組摘要列為 `role="group"` `aria-label="無排程任務的成員"`。
- 窄長條的點擊區與所有按鈕 ≥ 24 × 24px（core §8 為 28px 的地方照 core）。狀態不只靠顏色：左欄色點有 tooltip、逾期有文字。

## 11. Token 與 CSS 變數

- `.gantt` 區域變數：`--gantt-bar-h: 24px`、`--gantt-head-top: 28px`、`--gantt-head-bottom: 24px`、`--gantt-label-gap: 10px`、`--gantt-left`（見 §12）。
- 允許 `mix-blend-mode`、`opacity`；不允許寫死色碼或 `rgba()`。陰影只用 `--shadow-sm`（左欄捲動陰影、拖曳中）。轉場一律 `--duration-fast` + `--ease-standard`。

## 12. 響應式

| 寬度 | 規格 |
|---|---|
| ≥ 1280px | `--gantt-left: 300px`；全部規格如上 |
| 1024–1279px | `--gantt-left: 260px`；其餘相同 |
| 768–1023px | `--gantt-left: 200px`、任務列高 48px：標題第一行、日期區間第二行（取代原 `UpdatedAt`）；外側標題 `max-width:140px`；‹ › 隱藏；未排程列隱藏負責人名稱只留 Avatar、隱藏標題列右側說明；空分組摘要列可換行 |
| < 768px | 不在支援範圍：`--gantt-left: 140px`，只需不撐破 shell |

各寬度都必須符合 §1 的填滿規則：在 1280px 與 768px 檢查時間軸右側無空白、今天標籤不蓋刻度、單日任務可辨識標題。

## 13. 實作檢查清單

1. 截圖情境（1 筆 3 天任務、1 位無排程成員、1 筆未排程）下：時間軸填滿容器；長條右側看得到標題；「11/23」完整可讀且旁邊有「今天」膠囊；管理員不佔整列。
2. 切換日 / 週 / 月、調整視窗寬度、收合 Sidebar 後仍填滿且可視中心日期不跳動。
3. 週刻度看得到週末帶與今天帶；月份邊界線比週線深。
4. 左欄無「更新」欄；逾期任務日期為紅字；Tooltip 末行有更新資訊。
5. `timeline.test.ts` 涵蓋：`minDays` 延伸、今天 2/3 保證、`tail` 邊界、自動刻度門檻（28 / 182）。

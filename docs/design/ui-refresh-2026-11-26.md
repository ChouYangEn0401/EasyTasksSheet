# 設計規格 — UI 改版 2026-11-26（簡約白底・便利與顯示性）

> 📐 規範｜讀者：這一輪改 CSS 與元件的施工者（人與 AI agent）｜30 分鐘
> 建立：2026-11-26｜最後更新：2026-11-26
> 上游：[requirements-2026-11-26.md](../requirements-2026-11-26.md) §2～§4（U1～U6、R1～R4、M1～M5）。
> 基準：[core-shell.md](core-shell.md)（token 與基礎元件）、[delay-link.md](delay-link.md)、[personal.md](personal.md)、[task-discussion.md](task-discussion.md)、[product-principles.md](../product-principles.md)。
> **本文件只改「怎麼呈現」，不改資訊架構、不改後端 API。** 與 core-shell.md 衝突處以本文件為準；未提及者照舊。

## 0. 一句話與三條底線

**白底、單一藍色強調、灰階分層不變；調的是對比、字級層次、間距刻度、狀態色一致性，以及「一列／一卡看完所有關鍵資訊」。**

1. 不換主題、不加漸層、不加大色塊、不加第二個強調色。語意色只以「淡底＋深字」小面積出現。
2. 所有顏色、尺寸只用 `tokens.css` 的變數；本文件新增的變數也放進 `tokens.css`，各 feature CSS 不自訂色碼。
3. 阻擋鍊（U2）、本週與匯報（R1～R4）、Ctrl+K（U3）是這一輪的三個重點；其餘是微調。

### 0.1 施工前提：token 檔從 Tailwind `@theme` 改成純 `:root`

原生 JS 版沒有 Tailwind，`tokens.css` 的 `@theme static { … }` 與 `@theme inline { … }` 要改成一般的 `:root { … }`（變數名**完全不變**，含 `--text-sm--line-height` 這種雙橫線名稱）。各 feature CSS 開頭的 `@layer theme, base, components, utilities;` 保留（原生 CSS 支援 `@layer`，順序宣告仍有用）。
Tailwind utility class（`flex`、`gap-2`、`truncate`、`text-tertiary`、`mt-3`、`m-0`、`font-medium`…）在 JSX 裡零散出現，轉原生時在 `components.css` 補一小段等價的工具類（見 §1.6），不要逐處改 DOM。

---

## 1. Token 微調

全部寫在 `src/web/styles/tokens.css`（搬到原生版後位置照專案現況，例如 `web/static/css/tokens.css`）。**只列有改或新增的**；表中沒有的變數維持原值。對比值以白底 `#ffffff` 計算，正文字 ≥ 4.5:1、大字／非文字 ≥ 3:1（WCAG AA）。

### 1.1 中性與強調

| 變數 | 改前 | 改後 | 理由 |
|---|---|---|---|
| `--color-bg` | `#f7f8fa` | `#f6f7f9` | 與 surface 的層次再明顯一點點（側欄、看板欄底） |
| `--color-surface-hover` | `#f3f4f6` | `#f2f4f7` | 微調偏冷，與 bg 區分 |
| `--color-text-tertiary` | `#8b929d`（3.3:1 ✗） | **`#6b7380`**（4.7:1 ✓） | 時間戳、輔助文字到處都是 12px，原值不達 AA |
| `--color-text-disabled` | `#b4b9c1` | 不改 | 停用狀態不受 AA 文字規範 |
| `--color-border-strong` | `#c9cdd4` | `#c3c8d1` | hover 邊框對比略增（≥ 3:1 對白底近似，非文字） |
| `--color-overlay` | `rgba(20,24,32,.4)` | `rgba(20,24,32,.32)` | 抽屜／對話框遮罩淡一點，白底感不被壓暗 |
| **新增** `--color-surface-raised` | — | `#ffffff` | 浮層（選單、Ctrl+K、Popover）語意名，值同 surface，之後要微調時有地方改 |
| **新增** `--color-accent-border` | — | `#c3d6fa` | 選取框線（原本借用 `--color-info-border`，改成有名字） |

`--color-text`、`--color-text-secondary`（5.9:1）、`--color-accent*`、`--color-focus-ring` 不動。

### 1.2 語意色

只補 `warning` 的「文字用」橘：到期日「今天」要橘字，但 `--color-warning`（`#d98a0b`，2.9:1）不能當文字色，一律用 `--color-warning-text`（`#8f5a06`，6.9:1）。不新增變數，寫成規則。

### 1.3 狀態色：每種三件組補齊 `-border`，並新增 `blocked` / `paused` / `due-*`

既有 `todo／doing／review／done／overdue` 五種各補一個 `-border`（淡底 pill 要有 1px 同色系邊才不會「浮在白底上糊掉」）：

| 前綴 | dot（本色） | `-soft` | `-text` | **新增 `-border`** |
|---|---|---|---|---|
| `--color-status-todo` | `#8b929d` | `#f0f1f3` | `#4b5360` | `#d9dce2` |
| `--color-status-doing` | `#2f6feb` | `#eaf1fe` | `#1f56c4` | `#c3d6fa` |
| `--color-status-review` | `#8257d9` | `#f1ebfd` | `#5e3bb0` | `#dccffa` |
| `--color-status-done` | `#1f9d61` | `#e7f6ee` | `#15734a` | `#bfe5d0` |
| `--color-status-overdue` | `#d8433b` | `#fdecea` | `#a82c26` | `#f4c4c0` |
| **新增** `--color-status-blocked` | `#d98a0b` | `#fdf3df` | `#8f5a06` | `#f3d9a4` |
| **新增** `--color-status-paused` | `#e0762a` | `#fcefe6` | `#9a4a14`（6.2:1） | `#f5cdb3` |

- `blocked`＝琥珀，與 `warning` 同值但**有自己的名字**：delay-link.md §6.1「被擋住用琥珀、不用紅」的決定不變，只是不再到處寫 `--color-warning-soft`。
- `paused`（暫停）：資料庫的 `statuses.category` 只有 `todo／doing／done`，暫停不是 category。判法沿用 `review` 的作法（`lib/colors.ts` 的 `statusTone`）：**狀態名稱含「暫停」「擱置」「hold」或 `color = orange` → tone `paused`**。這是元件改動（§11 第二階段）；CSS 先把變數準備好。
- 到期日三色寫成規則，不另開變數：逾期 `--color-status-overdue-text`、今天 `--color-warning-text`、本週與其他 `--color-text-secondary`。

### 1.4 字級：四階（＋一個小字）與行高

| 階 | 變數 | 改前 | 改後 | 用途 |
|---|---|---|---|---|
| 標題 | `--text-xl` | 20 / 28 | 不改 | 頁面標題、抽屜標題 |
| 區塊 | `--text-lg` | 16 / 24 | 不改 | 卡片標題、Dialog 標題 |
| 正文 | `--text-sm` | 13 / 20 | 不改（**預設內文**） | 表格、導覽、按鈕、輸入框 |
| 正文（長） | `--text-base` | 14 / 22 | 不改 | 描述、討論內文、設定頁段落 |
| 輔助 | `--text-xs` | 12 / 16 | 不改 | 時間戳、徽章、欄位標籤 |
| **小字（新增）** | `--text-2xs` / `--text-2xs--line-height` | — | **11px / 14px** | 計數泡泡、側欄分組標題、鍵盤提示。目前 `11px` 在 `discussion.css`、`delayLink.css`、`tasks.css` 共出現 6 處，全部換成這個變數 |
| **數字（新增）** | `--text-num` | — | `28px / 32px` | 統計數字（本週卡、總覽卡）。原本用 `--text-2xl`（24），改 28 讓數字一眼跳出來；字重 600、`tabular-nums` |

字重不動（400／500／600）。**標題一律 600、按鈕與導覽 500、內文 400**。中文行高：`--text-sm` 的 20px 行高對中文剛好，不改。

### 1.5 間距、圓角、陰影

| 類別 | 改前 | 改後 |
|---|---|---|
| 間距 | `--space-1`=4 … `--space-12`=48 | 不改；**新增** `--space-0-5: 2px`、`--space-1-5: 6px`（6px 在 CSS 裡出現 60+ 次全是手寫，之後新寫的用變數，舊的不必回頭改） |
| 圓角 | sm 4 / md 6 / lg 10 / full | 不改；**新增** `--radius-xl: 12px`（Dialog、Ctrl+K 浮層、本週卡）。`--radius-lg` 10px 保留給一般卡片 |
| 陰影 | 四階 xs/sm/md/lg | **收成兩階、名字保留**（CSS 不用改）：<br>`--shadow-xs: 0 1px 2px rgba(16,24,40,.04)`（靜置：卡片、按鈕）<br>`--shadow-sm: var(--shadow-xs)`（別名）<br>`--shadow-md: 0 2px 6px rgba(16,24,40,.06), 0 12px 32px -8px rgba(16,24,40,.14)`（浮層：選單、Popover、Toast、Ctrl+K）<br>`--shadow-lg: var(--shadow-md)`（別名；Dialog、抽屜） |
| 控制項高度 | 28 / 32 / 40 | 不改 |
| 版面 | `--drawer-width` 480 | **`--drawer-width: 520px`**（抽屜要放相依區的鍊圖與每列五個欄位；≤ 1279px 仍 `min(520px, 100vw − 56px)`） |
| 版面 | `--row-height` 40 | 不改 |

### 1.6 轉原生時要補的工具類（放 `components.css` 末尾，`@layer utilities`）

JSX 裡用到的 Tailwind utility，只補這些（grep `className="` 確認後增減）：
`.flex{display:flex}` `.flex-col{flex-direction:column}` `.items-center{align-items:center}` `.gap-2{gap:8px}` `.gap-3{gap:12px}` `.gap-4{gap:16px}` `.gap-6{gap:24px}` `.mt-3{margin-top:12px}` `.mt-4{margin-top:16px}` `.m-0{margin:0}` `.truncate{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` `.font-medium{font-weight:var(--font-medium)}` `.text-xs{font-size:var(--text-xs);line-height:var(--text-xs--line-height)}` `.text-tertiary{color:var(--color-text-tertiary)}` `.text-secondary{color:var(--color-text-secondary)}`。

**驗收**：用瀏覽器 devtools 的對比檢查，隨機點 10 處 12px 灰字（時間戳、欄位標籤、側欄分組）全部 ≥ 4.5:1；全站 grep 不到 `#` 色碼（`tokens.css` 以外）；`--shadow-*` 只剩兩個不同的值。

---

## 2. 外殼（側欄、頂欄、頁面標題列、三種狀態畫面）

### 2.1 側欄（`shell.css` `.sidebar*`、`.nav-*`；`shell/Sidebar`）

```
┌ 232px ───────────────────┐
│ ◆ EasyTasksSheet         │ 52px 品牌列（logo 16px accent + 名稱 --text-base 600）
├──────────────────────────┤
│ 工作                     │ ← .nav-section-label（新增）11px 500 tertiary，上下 10/4px，左 18px
│ ▢ 總覽                   │
│ ▢ 任務                 ▾ │
│    清單                  │ ← 子項縮排 36px
│    看板                  │
│    甘特圖                │
│    延遲鏈                │
│ ▢ 問題回饋               │
│ ▢ 個人清單            3  │ ← 右側計數泡泡（本週到期數，選配；見 §6）
│ ▢ 工程追蹤               │
│ 管理                     │ ← 第二個分組標題（取代現在的 .sidebar-sep 細線）
│ ▢ 成員管理   ▢ 資料管理 …│
├──────────────────────────┤
│ « 收合側欄               │ 底部
│ v2.0.0 · 周暘恩          │ ← .sidebar-version（新增）11px tertiary，hover tooltip 顯示 repo 連結
└──────────────────────────┘
```

| 項目 | 規格 |
|---|---|
| 分組標題 `.nav-section-label` | `font-size: var(--text-2xs); line-height: 14px; font-weight: 500; color: var(--color-text-tertiary); padding: 10px 18px 4px; letter-spacing: .02em;` 第一組（工作）不顯示文字、只留 8px 上距（避免品牌列下面立刻一行小字）。管理組有才顯示 |
| 導覽項 `.nav-item` | 高 32、`margin: 0 8px`、`padding: 0 10px`、`gap: 10px`、`--radius-md`、`--text-sm` 500 `text-secondary`。**不改** |
| 選中 `[aria-current="page"]` | `background: var(--color-accent-soft); color: var(--color-accent-text);` 圖示同色。**改**：加 `box-shadow: inset 2px 0 0 var(--color-accent)`（左緣 2px 藍條，和清單選中列同一語言） |
| 群組展開 `[data-group-active]` | 文字 `--color-text`、字重 600；子項 `.nav-item--sub` 高 28、`padding-left: 36px`、`--text-sm` 400；子項選中同上但**不畫**左緣條（避免兩條） |
| 計數泡泡 `.nav-item-count` | `margin-left: auto; min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--radius-full); background: var(--color-surface-active); color: var(--color-text-secondary); font-size: var(--text-2xs); line-height: 18px; tabular-nums`。有未讀／到期時才 render |
| 折疊（56px） | 照舊只留圖示＋tooltip＋flyout；`.sidebar-version` 只顯示 `v2.0`（`.sidebar-version-short`），hover 顯示全文 |
| 底部 `.sidebar-footer` | `padding: 8px; border-top: 1px solid var(--color-border-subtle)`；收合鈕 ghost；底下 `.sidebar-version`：`display:flex; gap:6px; padding: 4px 10px 6px; font-size: var(--text-2xs); color: var(--color-text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` 內容由 `/api/health` 的 `version`／`author` 帶（同 `server/app/version.py`，H6） |

### 2.2 頂欄（`shell.css` `.header*`；`shell/Header`）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 頁面標題                [🔍 搜尋任務、專案、成員…      Ctrl K]  [＋ 新增 N]  ↶ ↷  (在線)  (頭像 王小明 ▾) │
└─────────────────────────────────────────────────────────────────────────────┘
```

| 項目 | 規格 |
|---|---|
| 高度／底 | 52px、surface、下緣 1px border。**不改** |
| 標題 `.header-title` | `--text-lg` 600。**不改** |
| **搜尋入口 `.header-search`（新增，元件）** | 長得像輸入框的按鈕：`width: 300px; height: var(--control-md); padding: 0 10px; display:flex; align-items:center; gap:8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); color: var(--color-text-tertiary); font-size: var(--text-sm); cursor: text;` 左 16px 搜尋圖示、中間 placeholder「搜尋任務、專案、成員…」、右側兩顆 `.ui-kbd`（`Ctrl` `K`；Mac 顯示 `⌘` `K`）。hover：`border-color: var(--color-border-strong); background: var(--color-surface)`。點擊＝開 §7 浮層。≤ 1279px 寬 220；≤ 1023px 只剩 32px 圖示按鈕 |
| QuickAdd `.header-quickadd` | 現在是 280px 的輸入框，和搜尋框並排會有兩個「輸入框」打架。**改**成 secondary 按鈕「＋ 新增任務」（右側 `.ui-kbd` `N`），點擊或按 `N` 在原地展開成 320px 輸入框（`.header-quickadd[data-open]`，transition width `--duration-base`），Enter 建立、Esc 收回；連續新增行為照 core §7.1 不變。這是元件改動（§11 第二階段）；第一階段先把兩個都縮：搜尋 240、QuickAdd 220 |
| 右側順序 | 搜尋 → 新增 → 復原／重做 → 在線頭像堆 → 使用者選單。間距 12px。**不改** |
| 使用者選單 | 面板寬 220、頂部資訊、個人設定／變更密碼／登出。**不改**；資訊區最下面加一行 `.user-menu-version`（11px tertiary）「EasyTasksSheet v2.0.0」 |

### 2.3 頁面標題列（新增 `.page-head`，給沒有 ViewTabs 的頁用：個人清單、設定、管理頁、工程追蹤）

```html
<div class="page-head">
  <div class="page-head-main">
    <h2 class="page-head-title">個人清單</h2>
    <p class="page-head-sub">本週 11/24–11/30 · 第 48 週</p>
  </div>
  <div class="page-head-actions">…按鈕…</div>
</div>
```
`.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:var(--space-4)}`
`.page-head-title{margin:0;font-size:var(--text-xl);line-height:var(--text-xl--line-height);font-weight:600}`
`.page-head-sub{margin:2px 0 0;font-size:var(--text-sm);color:var(--color-text-secondary)}`
`.page-head-actions{display:flex;gap:8px;flex-wrap:wrap}`。頂欄已顯示頁名，所以 `.page-head-title` **只在頁面有副標或動作時才出現**（個人頁、設定頁），其餘頁不加，避免標題重複兩次。

### 2.4 空狀態、載入態、錯誤態（`components.css` `.ui-empty*`、`.ui-skeleton`）

| 狀態 | 規格 |
|---|---|
| 空狀態 `.ui-empty` | `padding: 48px 16px; gap: 6px`；圖示改放在 **44px 圓底** `.ui-empty-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:var(--radius-full);background:var(--color-bg);color:var(--color-text-tertiary);margin-bottom:10px}` 內，圖示 20px；標題 `--text-base` 500；說明 `--text-sm` secondary、`max-width: 420px`；動作鈕 secondary，`margin-top: 14px`。文案維持中性（「目前沒有…」「在 … 加入 … 就能在這裡看到」） |
| 錯誤態 `.ui-empty--error` | 同版型，圓底 `--color-danger-soft`、圖示 `--color-danger`；標題「載入失敗」、說明＝錯誤訊息（`--text-sm` secondary）、按鈕「重試」secondary。**所有頁面的錯誤都走這一個**，不再有各自的紅字段落 |
| 載入態 `.ui-skeleton` | 底 `--color-surface-active`、`--radius-sm`、脈動 1.2s（reduced-motion 停）。**規則**：每個清單／卡片的 skeleton 列數＝該區塊常見筆數（清單 6、本週卡每欄 3、抽屜 6），寬度交錯（60%／45%／70%），**高度＝真實列高**（清單 40、卡片 96），載入完不跳版 |
| 頁內提示列 `.ui-alert` | 不改 |

**驗收**：側欄每個分組上方有 11px 灰字標題、選中項左緣有 2px 藍條；頂欄一眼分得出「搜尋」與「新增」是兩件事；任一頁斷網重整，錯誤畫面長得一樣、都有「重試」。

---

## 3. 清單列（`tasks.css` `.tl-*`、`ListTable`、`TitleBadges`）

目標：**一列看完**狀態點＋標題＋負責人頭像＋期限（三色）＋進度條＋阻擋標記。

### 3.1 欄寬（`model.ts` 的 `W`）

| 欄 | 改前 | 改後 | 說明 |
|---|---|---|---|
| check | 40 | 40 | 完成圓鈕 18px |
| title | `minmax(280px, 1fr)` | `minmax(300px, 1fr)` | 標題左側多一顆 8px 狀態點（§3.2） |
| status | 128 | 120 | pill 寬度夠 |
| assignee | 144 | 136 | 頭像 20 + 名字 |
| startDate / dueDate | 104 | 100 | `11/28`／`2027/01/03` |
| estimate | 80 | 80 | |
| **progress（新顯示）** | — | 112 | 條 56px + `40%` |
| updated | 96 | 96 | |
| custom | 144 | 144 | |

`progress` 欄的 `kind: 'progress'` 已存在（抽屜在用），清單預設欄位清單加入它、`hideable: true`、排在到期日後。沒有 progress（=0 且非完成）顯示 `—`。

### 3.2 一列的 DOM（任務列）

```html
<div class="tl-row tl-row--task" data-selected data-done data-due="overdue|today|week|later">
  <div class="tl-cell tl-cell--check tl-sticky-0"><button class="tl-done" aria-pressed>…</button></div>
  <div class="tl-cell tl-cell--title tl-sticky-1">
    <span class="tl-status-dot" style="--status-dot:…" aria-hidden="true"></span>   <!-- 新增 -->
    <div class="tl-field tl-field--title"><span class="tl-title-text">標題</span></div>
    <span class="tl-tbadges">…TitleBadges（§3.4 的 dep-mark 在這裡）…</span>
  </div>
  <div class="tl-cell"><span class="ui-status-badge">● 進行中</span></div>
  <div class="tl-cell"><span class="tl-person"><span class="ui-avatar ui-avatar--xs">王</span><span class="tl-truncate">王小明</span></span></div>
  <div class="tl-cell tl-cell--due"><time class="tl-due">11/28</time></div>
  <div class="tl-cell tl-cell--progress"><span class="tl-progress"><span style="width:40%"></span></span><span class="tl-progress-num">40%</span></div>
  …
</div>
```

| 項目 | 規格 |
|---|---|
| 列高 | `--row-height` 40。hover `--color-surface-hover`；選中 `--color-accent-soft` + `inset 2px 0 0 var(--color-accent)`（**不改**） |
| 狀態點 `.tl-status-dot`（新增） | `flex:none; width:8px; height:8px; border-radius:50%; background: var(--status-dot); margin: 0 2px 0 10px`。把狀態欄藏掉的人也看得到狀態 |
| 標題 `.tl-title-text` | `--text-sm` 400 `--color-text`；完成：tertiary＋刪除線（不改） |
| 負責人 `.tl-person` | 頭像 `ui-avatar--xs`（20）＋名字 `--text-sm` secondary，`gap: 6px`；未指派：虛線頭像＋「未指派」tertiary |
| 期限 `.tl-due` | `--text-sm` tabular-nums；`.tl-row[data-due="overdue"] .tl-due{color:var(--color-status-overdue-text);font-weight:500}`（後接 `· 3 天` 用 `--text-xs`）；`[data-due="today"] .tl-due{color:var(--color-warning-text);font-weight:500}`，文字顯示「今天」；`[data-due="week"] .tl-due{color:var(--color-text)}`；其餘 `--color-text-secondary`。已完成的列不套三色（一律 tertiary） |
| 進度 `.tl-progress` | `width:56px;height:4px;border-radius:var(--radius-full);background:var(--color-surface-active);overflow:hidden` + 內層 `background: var(--status-dot, var(--color-accent))`（跟隨該列狀態色；完成＝綠滿格）；`.tl-progress-num{margin-left:8px;font-size:var(--text-xs);color:var(--color-text-secondary);tabular-nums;min-width:30px;text-align:right}` |
| 表頭 `.tl-hcell` | 高 36、`--text-xs` 500 secondary、底 `--color-bg`。**不改** |
| 群組列 `.tl-row--group` | 高 36；文字 `--text-sm` 600 `--color-text`＋計數泡泡（同 `.nav-item-count` 樣式，class `.tl-group-count`）。目前是 secondary 400，改成 600 讓分組看得出來 |
| 列動作 `.tl-row-actions` | hover 才出現。**不改** |

### 3.3 阻擋標記（清單列與看板卡共用，`dependency.css`）

把現在「只有一個沙漏」的標示改成**兩顆有數字的小 pill**，放在 TitleBadges 的 `waiting` 位置（優先序：未讀留言 > 被擋 > 擋著 > 有人在看 > 待辦 > 相關 > 留言數 > 鎖）：

```html
<span class="dep-mark dep-mark--blocked" role="img" aria-label="等待 2 個前置任務完成，預計延後 3 天">
  <svg class="dep-mark-icon"><!-- lock 12px --></svg>2
</span>
<span class="dep-mark dep-mark--blocks" role="img" aria-label="完成後，有 3 個任務可以開始">
  <svg class="dep-mark-icon"><!-- link / chain 12px --></svg>3
</span>
```
```css
.dep-mark{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 5px;border-radius:var(--radius-full);
  font-size:var(--text-2xs);line-height:1;font-weight:500;font-variant-numeric:tabular-nums;border:1px solid transparent}
.dep-mark--blocked{background:var(--color-status-blocked-soft);color:var(--color-status-blocked-text);border-color:var(--color-status-blocked-border)}
.dep-mark--blocks{background:var(--color-surface-active);color:var(--color-text-secondary)}
.dep-mark-icon{width:12px;height:12px}
```
需求文字寫的 🔒／⛓ 是意思，**畫面用線條圖示不用 emoji**（全站圖示規則）。Tooltip 文案沿用 `depText.ts` 的 `blockedTooltip`／`blocksTooltip`。

**驗收**：在 1280px 寬、側欄展開、預設欄位下沒有水平捲軸；隨便挑一列，不開抽屜就能說出「狀態、誰、哪天到期、幾 %、被誰擋」；逾期列的日期是紅字、今天到期是橘字「今天」。

---

## 4. 看板卡片（`kanban.css`、`KanbanCard`）

```
┌───────────────────────────────┐
│ ● 專案名稱                 🔖 │ ← .kanban-card-project（色點 + 名稱，text-xs tertiary）
│ 任務標題最多兩行…             │ ← .kanban-card-title（text-sm 500，clamp 2 行；原 3 行）
│ ▓▓▓▓▓▓░░░░░░░░░░░░░ 40%       │ ← .kanban-card-progress（新增；只在 0<progress<100 時出現）
│ (王) 王小明   📅 11/28  💬 3  ⏱ 2 時前 │ ← .kanban-card-meta
│ [🔒 等待 2 · 預計延後 3 天 → 12/20] [⛓ 3] │ ← .dep-badges（既有，樣式換成 §3.3 的三件組）
└───────────────────────────────┘
```

| 項目 | 規格 |
|---|---|
| 卡片 | `padding: 12px; gap: 8px; border: 1px solid var(--color-border); border-radius: var(--radius-lg)`（原 md → **lg**，和欄的 lg 一致）；`box-shadow: var(--shadow-xs)`；hover `border-color: var(--color-border-strong)`；選中 `border-color: var(--color-accent); background: var(--color-accent-soft)`（不改） |
| 標題 | `-webkit-line-clamp: 2`（原 3）。超過兩行的標題在 tooltip 顯示全文 |
| 進度 `.kanban-card-progress` | `display:flex;align-items:center;gap:8px` → 條 `flex:1;height:4px;border-radius:full;background:var(--color-surface-active)` 內層 `background:var(--status-dot)`；數字 `--text-xs` secondary tabular |
| meta | `--text-xs` secondary，`gap: 12px`；頭像 `ui-avatar--sm`（24）＋名字（≥ 1280px 才顯示名字，`.kanban-meta-name`）；期限 `.kanban-due` 三色同 §3.2（逾期維持既有 `.kanban-due--overdue` pill；今天 `.kanban-due--today` 橘字）；留言數；更新時間靠右 |
| 被擋住的卡 `.dep-card--blocked` | 左緣 3px `--color-status-blocked`、底 `color-mix(in srgb, var(--color-status-blocked-soft) 55%, var(--color-surface))`（值不變、換變數名） |
| 欄標頭 `.kanban-col-head` | 高 36：8px 狀態點 → 名稱 `--text-sm` 600 → **計數泡泡 `.kanban-col-count`**（新增，樣式同 `.nav-item-count`，顯示張數）→ 右側 `.kanban-col-sum`（估時合計，`--text-xs` tertiary）。目前張數和估時擠在同一段文字裡，分開 |
| 欄 `.kanban-col` | 底 `--color-bg`、`--radius-lg`；寬 288／272／264。**不改** |
| 拖曳中 | 原位 `.is-placeholder`：1px dashed `--color-border-strong`、透明底（不改）。浮層 `.is-overlay`：`transform: scale(1.02); box-shadow: var(--shadow-md)`（原 sm → md，拿起來要看得出離開桌面）。**放置目標欄** `.kanban-col.is-over`：`background: var(--color-surface-active); outline: 2px dashed var(--color-accent-border); outline-offset: -2px`（原本只換底色，加虛線框讓目標更明確）；目標欄的空狀態框 `border-color: var(--color-accent)` |
| 卡間插入線 | 若拖曳實作有「插在兩張之間」的位置，畫法同清單：目標卡上緣 2px `--color-accent` 線＋左端 8px 圓點（`listDnd.css` 的 `[data-drop='before']` 搬用，class 改 `.kanban-card[data-drop='before']`） |

**驗收**：卡片資訊和清單列一致（狀態、誰、期限、進度、阻擋）；拖起時卡片明顯「浮起」、目標欄有虛線框；欄標頭能分別讀出「幾張」與「幾小時」。

---

## 5. 阻擋鍊（重點；`dependency.css`、`delayLink.css`、`DependenciesSection`、`DelayLinkPage`）

用詞照 delay-link.md §6.1 的中性原則：**「等待中」「前置任務」「完成後可開始」「預計延後」**，不出現「卡住」「拖延」。使用者口語的「卡在哪一節」畫面上寫成「**目前等待的節點**」。區塊名由「依賴」改為「**相依**」（兩字都通，統一用需求文件的字），aria 文案同步。

### 5.1 任務抽屜「相依」區塊

```
┌ 相依                                              看整條鏈 → ┐  ← .tl-section-title + 右側連結
│ ┌ 等待中 · 2 個前置任務 · 預計延後 3 天（到 12/20）────────┐ │  ← .dep-self（只在被擋時出現）
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│  擋著我的（上游） 2                              ＋ 新增   │  ← .dep-group-head
│  ○──●  儀器校正            (李) 李大華  11/25  逾期 1 天 → │  ← .dep-row（鏈節）
│  │  ●  資料清理            (王) 王小明  11/27  預計可如期  │
│  ▼                                                         │
│  ◉  本任務：撰寫週報        (我) 我      11/28  預計延後 3 天 │  ← .dep-row--self
│  ▼                                                         │
│  我擋著的（下游） 1                              ＋ 新增   │
│  ●  投影片排版              (陳) 陳小美  12/01            → │
└────────────────────────────────────────────────────────────┘
```

DOM 草圖（一個區塊、一條垂直時間線、三段）：

```html
<section class="task-drawer-section dep-section" aria-labelledby="dep-title-12">
  <div class="tl-section-title">
    <span id="dep-title-12">相依 <span class="tr-count">3</span></span>
    <a class="tl-link dep-chain-link" href="/tasks/delay-link?focus=12">看整條鏈 →</a>
  </div>
  <div class="dep-self">…等待中 · 預計延後 3 天（到 12/20）…</div>

  <ol class="dep-chain">
    <li class="dep-chain-seg dep-chain-seg--up">
      <div class="dep-group-head"><span>擋著我的（上游）</span><span class="dep-group-count">2</span><button class="ui-btn ui-btn--ghost ui-btn--sm">＋ 新增</button></div>
      <ul class="dep-list">
        <li class="dep-row is-current-wait" data-overdue="true">
          <span class="dep-node" style="--status-dot:…"><span class="dep-node-dot"></span></span>
          <button class="dep-row-title">儀器校正</button>
          <span class="dep-row-person"><span class="ui-avatar ui-avatar--xs">李</span>李大華</span>
          <time class="dep-row-due">11/25</time>
          <span class="dep-row-state dep-row-state--overdue">逾期 1 天</span>
          <button class="dep-row-open" aria-label="開啟">→</button>
          <button class="dep-row-remove" aria-label="移除">✕</button>
        </li>
        …
      </ul>
    </li>
    <li class="dep-chain-seg dep-chain-seg--self">
      <div class="dep-row dep-row--self">…本任務…</div>
    </li>
    <li class="dep-chain-seg dep-chain-seg--down">…我擋著的（下游）…</li>
  </ol>
</section>
```

CSS 草稿（接在 `dependency.css` 的「任務詳情：依賴區」段，舊的 `.dep-section-group / .dep-subtitle / .dep-row` 規則改名或刪）：

```css
.dep-chain{list-style:none;margin:0;padding:0;position:relative}
/* 垂直時間線：畫在節點欄中央（節點欄 20px → 線在 x=9.5） */
.dep-chain::before{content:'';position:absolute;left:9px;top:12px;bottom:12px;width:2px;background:var(--color-border);border-radius:1px}
.dep-chain-seg + .dep-chain-seg{margin-top:4px}
.dep-group-head{display:flex;align-items:center;gap:8px;min-height:28px;padding-left:30px;
  font-size:var(--text-xs);color:var(--color-text-secondary);font-weight:500}
.dep-group-count{min-width:18px;height:18px;padding:0 5px;border-radius:var(--radius-full);background:var(--color-surface-active);
  font-size:var(--text-2xs);line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.dep-group-head .ui-btn{margin-left:auto}

.dep-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dep-row{position:relative;display:grid;align-items:center;column-gap:8px;min-height:36px;padding:4px 4px 4px 0;border-radius:var(--radius-md);
  grid-template-columns:20px minmax(0,1fr) auto 44px auto auto auto}
/*                      節點  標題            人   到期  狀態  開 刪 */
.dep-row:hover,.dep-row:focus-within{background:var(--color-surface-hover)}
.dep-node{display:grid;place-items:center;width:20px;height:20px}
.dep-node-dot{width:10px;height:10px;border-radius:50%;background:var(--status-dot);box-shadow:0 0 0 2px var(--color-surface)} /* 蓋在線上 */
.dep-row-title{min-width:0;padding:0;border:0;background:none;font:inherit;font-size:var(--text-sm);color:var(--color-text);text-align:left;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dep-row-title:hover{color:var(--color-accent-text);text-decoration:underline;text-underline-offset:2px}
.dep-row-person{display:inline-flex;align-items:center;gap:4px;max-width:96px;font-size:var(--text-xs);color:var(--color-text-secondary);overflow:hidden;white-space:nowrap}
.dep-row-due{font-size:var(--text-xs);color:var(--color-text-secondary);font-variant-numeric:tabular-nums;text-align:right}
.dep-row[data-overdue="true"] .dep-row-due{color:var(--color-status-overdue-text);font-weight:500}
.dep-row-state{height:18px;padding:0 6px;border-radius:var(--radius-full);font-size:var(--text-2xs);line-height:18px;white-space:nowrap;border:1px solid transparent}
.dep-row-state--overdue{background:var(--color-status-overdue-soft);color:var(--color-status-overdue-text);border-color:var(--color-status-overdue-border)}
.dep-row-state--delay{background:var(--color-status-blocked-soft);color:var(--color-status-blocked-text);border-color:var(--color-status-blocked-border)}
.dep-row-state--ok{background:var(--color-success-soft);color:var(--color-success-text)}
.dep-row-state--unknown{background:var(--color-surface-active);color:var(--color-text-secondary)}
.dep-row-open,.dep-row-remove{opacity:0}
.dep-row:hover .dep-row-open,.dep-row:focus-within .dep-row-open,.dep-row:hover .dep-row-remove,.dep-row:focus-within .dep-row-remove{opacity:1}
@media (hover:none){.dep-row-open,.dep-row-remove{opacity:1}}
.dep-row.is-done{opacity:.6}
.dep-row.is-done .dep-row-title{text-decoration:line-through}

/* 目前等待的節點：上游中「決定本任務預計開始日」的那一個（projection 最晚、未完成），琥珀外圈 */
.dep-row.is-current-wait .dep-node-dot{box-shadow:0 0 0 2px var(--color-surface),0 0 0 4px var(--color-status-blocked)}
/* 標籤用真的元素，不用 ::after（要能被讀屏讀到、要能換行） */
.dep-wait-tag{height:18px;padding:0 6px;border-radius:var(--radius-full);background:var(--color-status-blocked-soft);color:var(--color-status-blocked-text);
  font-size:var(--text-2xs);line-height:18px;margin-left:4px} /* 放在標題後方：「儀器校正 [目前等待]」 */

/* 本任務那一列 */
.dep-row--self{grid-template-columns:20px minmax(0,1fr) auto 44px auto;background:var(--color-accent-soft);border-radius:var(--radius-md)}
.dep-row--self .dep-node-dot{width:12px;height:12px;background:var(--color-accent);box-shadow:0 0 0 2px var(--color-surface),0 0 0 4px var(--color-accent-border)}
.dep-row--self .dep-row-title{font-weight:500;cursor:default;text-decoration:none;color:var(--color-text)}
.dep-row--self .dep-row-title::before{content:'本任務 · ';color:var(--color-text-tertiary);font-weight:400}

/* 鏈線在下游段改成淡色（已經「可開始」的方向） */
.dep-chain-seg--down .dep-row .dep-node-dot{box-shadow:0 0 0 2px var(--color-surface)}
.dep-none{padding:4px 0 4px 30px;font-size:var(--text-sm);color:var(--color-text-tertiary)}
```

規則：
- **每一條顯示**：狀態點、標題、負責人（頭像＋名）、到期日、狀態字（逾期 N 天／預計延後 N 天／預計可如期／對方尚未排程／已完成）。逾期天數＝`今天 − dueDate`（未完成、dueDate < 今天），用紅字 pill——這是「日期事實」，與全站逾期日期同色；「預計延後」維持琥珀（那是推算）。
- **「目前等待」標籤**只掛在上游一條：未完成且 `projection.projectedEnd` 最晚的那一條（相同再比 `delayDays`）；沒有未完成上游就不掛。
- 上游／下游都可能是多條；超過 5 條折成「還有 N 條」連結（`.dep-more`，點開全部）。
- 「看整條鏈 →」帶 `?focus=<taskId>` 到延遲鏈頁（§5.3）。
- 新增選單（`.dep-picker`）、移除＋toast 復原、循環錯誤文案：**不改**。
- 行動版（≤ 767px）：grid 改兩行：`grid-template-columns:20px minmax(0,1fr) auto`，人與到期換到第二行（`.dep-row-sub`），狀態 pill 留第一行右側。

### 5.2 清單列與看板卡的小標記

見 §3.3／§4：`.dep-mark--blocked`（琥珀，數字＝`blockedByCount`）、`.dep-mark--blocks`（中性，數字＝`blocksCount`）。看板底部 `.dep-badge--waiting` 文字維持「等待中 · 預計延後 3 天 → 12/20」，顏色換成 `--color-status-blocked-*` 三件組；`.dep-badge--blocks` 改成「⛓ 3」短版（長文留在 tooltip）。「顯示依賴標示」開關照舊。

### 5.3 延遲鏈頁面（`delayLink.css`、`DelayLinkPage`）

現況：每條鏈一張卡、左到右分層、SVG 箭頭、關鍵路徑琥珀粗線。**保留這套畫法**，補四件事：

1. **卡片標頭改成摘要列**（`.dl-chain-head` → 加 `.dl-chain-stats`）：
   ```html
   <header class="dl-chain-head">
     <h3 class="dl-chain-title">從「儀器校正」開始的依賴鏈</h3>
     <ul class="dl-chain-stats">
       <li><b>5</b> 個任務</li>
       <li><b>2</b> 個等待中</li>
       <li class="is-delay">最多延後 <b>3</b> 天</li>
       <li>預計 <b>12/20</b> 全部完成</li>
       <li>目前等待：<button class="dl-link">儀器校正</button></li>
     </ul>
   </header>
   ```
   `.dl-chain-stats{display:flex;flex-wrap:wrap;gap:4px 16px;margin:4px 0 0;padding:0;list-style:none;font-size:var(--text-sm);color:var(--color-text-secondary)}` `b{font-weight:600;color:var(--color-text);font-variant-numeric:tabular-nums}` `.is-delay b{color:var(--color-status-blocked-text)}`。「目前等待」＝關鍵路徑上第一個未完成節點。
2. **節點卡補負責人名與逾期**（`.dl-node`，寬維持 `DEFAULT_LAYOUT.nodeWidth`、高 +16px 放第三行）：第二行 `頭像 + 名字（text-xs secondary，截斷）+ 狀態點名`；第三行 `原定 11/25 → 預計 11/28` ＋ 右側徽章。逾期節點：日期紅字並在徽章列加 `.dl-badge--overdue`「逾期 1 天」（`--color-status-overdue-*`），和「+3 天」琥珀徽章並存。被擋住的節點左緣 3px `--color-status-blocked`（和看板卡同語言）。
3. **聚焦**：網址 `?focus=<id>` 時，含該任務的鏈排到最上面、該節點 `.is-focus`（`outline:2px solid var(--color-accent);outline-offset:2px`）、卷到可見、其他鏈折成只剩標頭（`.dl-chain[data-collapsed]`，點標頭展開）。來自抽屜的「看整條鏈 →」就靠這個。
4. **圖例固定一行**（`.dl-legend`）：琥珀粗線＝決定最終完成日的路徑、虛線＝已完成的前置（不再擋）、琥珀左緣＝等待中、紅字＝已逾期。放在摘要列下方，`--text-xs` secondary。

另外：頂部 `.dl-summary`「共 N 條依賴鏈・最長預計延後 M 天」維持；篩選列沿用 FilterBar；窄螢幕堆疊版沿用。

**驗收**：開一個被兩個任務擋住的任務抽屜，不捲動就能看到上游兩條（誰、哪天、逾期幾天、哪一條標了「目前等待」）、本任務列、下游一條；點任一條能跳過去、點「看整條鏈」到延遲鏈頁且該節點被框起來；清單與看板上被擋的任務有「🔒 2」樣式的琥珀 pill。

---

## 6. 本週任務與匯報（`personal.css`、`PersonalPage`、`ReportDialog`、`reportFormat.ts`）

### 6.1 個人頁最上面「本週」卡（R1）

```
┌ 本週  11/24 – 11/30 · 第 48 週                                   [匯報 ▾] [今日 ▾] ┐
│ ┌ 進行中 ───────── 4 ┐ ┌ 本週到期 ─────── 3 ┐ ┌ 本週完成 ─────── 5 ┐ │
│ │ ● 撰寫週報  40%  11/28 │ │ ● 儀器校正   逾期 1 天 │ │ ✓ 資料清理      11/25 │ │
│ │ ● 投影片排版     12/01 │ │ ● 撰寫週報      11/28 │ │ ✓ 訂購試劑      11/26 │ │
│ │ ● 資料備份       —    │ │ ● 回覆審稿      今天  │ │ ✓ …                    │ │
│ │ 還有 1 項 →           │ │                       │ │ 還有 2 項 →            │ │
│ └───────────────────────┘ └───────────────────────┘ └───────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

DOM：
```html
<section class="pl-card pl-week" aria-labelledby="pl-week-title">
  <div class="pl-card-head">
    <h2 id="pl-week-title" class="pl-card-title">本週</h2>
    <span class="pl-week-range">11/24 – 11/30 · 第 48 週</span>
    <span class="pl-card-controls">
      <button class="ui-btn ui-btn--primary ui-btn--sm">匯報 ▾</button>   <!-- 開 §6.2，預選「個人週報」 -->
      <button class="ui-btn ui-btn--secondary ui-btn--sm">今日 ▾</button> <!-- 同對話框，範圍＝今天，預選「工作日誌」（R4） -->
    </span>
  </div>
  <div class="pl-week-grid">
    <div class="pl-week-col" data-kind="doing">
      <div class="pl-week-col-head"><span class="pl-week-col-label">進行中</span><b class="pl-week-num">4</b></div>
      <ul class="pl-week-list">
        <li class="pl-week-item" data-due="week"><span class="tl-status-dot" style="--status-dot:…"></span><button class="pl-week-title">撰寫週報</button><span class="pl-week-pct">40%</span><time class="pl-week-due">11/28</time></li>
        …最多 5 筆
      </ul>
      <a class="pl-week-more" href="/tasks/list?assignee=me&status=doing">還有 1 項 →</a>
    </div>
    <div class="pl-week-col" data-kind="due">…</div>
    <div class="pl-week-col" data-kind="done">…</div>
  </div>
</section>
```
```css
.pl-week{border-radius:var(--radius-xl)}
.pl-week-range{font-size:var(--text-sm);color:var(--color-text-secondary);font-variant-numeric:tabular-nums}
.pl-week-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--color-border-subtle)} /* 1px 分隔用底色做 */
.pl-week-col{display:flex;flex-direction:column;background:var(--color-surface);padding:12px 16px 10px;min-height:168px}
.pl-week-col-head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px}
.pl-week-col-label{font-size:var(--text-sm);font-weight:500;color:var(--color-text-secondary)}
.pl-week-num{font-size:var(--text-num);line-height:var(--text-num--line-height);font-weight:600;font-variant-numeric:tabular-nums;color:var(--color-text)}
.pl-week-col[data-kind="due"] .pl-week-num[data-has-overdue="true"]{color:var(--color-status-overdue-text)} /* 只有「本週到期」裡有逾期時數字變紅 */
.pl-week-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.pl-week-item{display:flex;align-items:center;gap:8px;min-height:28px;font-size:var(--text-sm)}
.pl-week-title{flex:1;min-width:0;padding:0;border:0;background:none;font:inherit;text-align:left;color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.pl-week-title:hover{color:var(--color-accent-text);text-decoration:underline;text-underline-offset:2px}
.pl-week-pct{font-size:var(--text-xs);color:var(--color-text-secondary);font-variant-numeric:tabular-nums}
.pl-week-due{flex:none;width:52px;text-align:right;font-size:var(--text-xs);color:var(--color-text-secondary);font-variant-numeric:tabular-nums}
.pl-week-item[data-due="overdue"] .pl-week-due{color:var(--color-status-overdue-text);font-weight:500}
.pl-week-item[data-due="today"] .pl-week-due{color:var(--color-warning-text);font-weight:500}
.pl-week-col[data-kind="done"] .pl-week-title{color:var(--color-text-secondary)}
.pl-week-more{margin-top:auto;padding-top:6px;font-size:var(--text-xs);color:var(--color-accent-text);text-decoration:none}
.pl-week-empty{margin:auto 0;font-size:var(--text-sm);color:var(--color-text-tertiary)} /* 「這週還沒有」 */
@media (max-width:1023px){.pl-week-grid{grid-template-columns:1fr}.pl-week-col{min-height:0}}
```
- 三欄定義：**進行中**＝我負責、category `doing`（不論日期）；**本週到期**＝我負責、未完成、dueDate 在本週一～日**或已逾期**（逾期排最前、紅字）；**本週完成**＝我負責、本週內完成（有 `completedDate`／done 時間）。資料來源＝既有 `GET /api/tasks`＋個人頁已有的 model（`assignedRows`），**不加端點**；週一起算與 `reportFormat.presetRange('week')` 同一支。
- 本週卡放在 `.pl-grid` 上方、佔滿寬；原「指派給我的任務」卡保留在下面（它是全部，不限本週）。
- 數字用中性灰黑；只有「本週到期」含逾期時數字變紅（這是給自己看的，不違反總覽的不排名原則）。空欄文案：「這週還沒有進行中的任務」「本週沒有到期的任務」「本週還沒有完成紀錄」。

### 6.2 匯報對話框（R2～R4；`ReportDialog`，Dialog `lg` 880px）

```
┌ 匯報 ─────────────────────────────────────────────────────────────── ✕ ┐
│ 模版  [工作日誌] [個人週報] [PL 匯報] [設計決議]      ← .rp-templates（分段鈕）      │
│ 範圍  [本週 ▾] 11/24 – 11/30   成員 [我自己 ▾]（PL 匯報才出現多選）                  │
│ 內容  ☑ 完成 ☑ 進行中 ☐ 延後 ☐ 取消 ☐ 本期建立   ☑ 顯示進度%  ☐ 含自由待辦           │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌ 預覽（.rp-preview）────────────────────────────────────┐ 共 8 項 · 5 完成     │
│ │ [量測系統] - 王小明                                      │                      │
│ │ ・儀器校正_完成                                          │                      │
│ │ ・撰寫週報 (40%)                 ← 橘                    │                      │
│ │ ・資料備份 暫停...(10%)          ← 紅                    │                      │
│ │ [文件整理] - 王小明                                      │                      │
│ │ ・…                                                      │                      │
│ └──────────────────────────────────────────────────────────┘                      │
│ [預覽 | 純文字]                                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ [📋 一鍵複製]  [下載 .md] [下載 .html] [列印]                      [關閉]        │
└─────────────────────────────────────────────────────────────────────────┘
```

| 項目 | 規格 |
|---|---|
| 模版列 `.rp-templates` | 分段按鈕組：`display:inline-flex;padding:2px;border-radius:var(--radius-md);background:var(--color-bg)`，每顆 `.rp-template{height:28px;padding:0 12px;border:0;border-radius:var(--radius-sm);font-size:var(--text-sm);color:var(--color-text-secondary)}`，選中 `background:var(--color-surface);color:var(--color-text);font-weight:500;box-shadow:var(--shadow-xs)`（同 `.disc-filter` 的作法）。四個：**工作日誌／個人週報／PL 匯報／設計決議** |
| 範圍 | 沿用 `RANGE_PRESETS`；「今日」入口進來時預選新增的 `today`（今天～今天）。R4 的「每日 PPT」就是工作日誌＋今日 |
| 預覽 `.rp-preview` | `min-height:240px;max-height:46vh;overflow:auto;padding:16px 20px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-lg);font-size:var(--text-base);line-height:1.7` —— 這一格要長得像「貼進 Word 之後的樣子」，所以用 `--text-base`（14）、1.7 行高、黑字 |
| 右側摘要 | `.rp-summary`（`--text-sm` secondary）「共 8 項 · 5 完成 · 2 進行中 · 1 暫停」 |
| 動作列 | 左：主按鈕「一鍵複製」（primary，複製後 1.5 秒變「已複製 ✓」success 字）＋「下載 .md」「下載 .html」「列印」（secondary）；右：「關閉」。既有的 CSV／純文字下拉保留在「下載」旁的 ▾ 裡（不佔主位） |
| 複製行為 | **同時寫 `text/plain` 與 `text/html`**（`ClipboardItem`）：貼進 Word／Google Docs／Slack 保留顏色與條列，貼進純文字框拿到乾淨文字。瀏覽器不支援 `ClipboardItem` 時退回純文字＋toast 說明 |

**工作日誌格式（照使用者截圖，是 R2 的驗收標準）**：

```
[專案名稱] - 人名
- 任務標題_完成
- 任務標題 (40%)
- 任務標題 暫停...(10%)
```
- 一個專案一段：`[專案] - 人名` 一行（粗體），底下每個任務一條（`-` 或 `・`；HTML 版用 `<ul><li>`）。
- 任務尾巴三種：完成 → `_完成`（一般字色）；進行中 → ` (NN%)`（**橘** `--color-warning-text`，整條標題也可選「尾巴橘、標題黑」，預設只尾巴橘）；暫停 → ` 暫停...(NN%)`（**紅** `--color-danger-text`）。
- 「暫停」判法＝§1.3 的 `paused` tone（狀態名含暫停／擱置／hold 或 color=orange）；完成＝category done；其餘都算進行中。這個對映寫在 `reportFormat.ts` 的純函式 `worklogState(task)`，可單元測試。
- 沒有進度（0）的進行中：顯示 ` (進行中)`，不顯示 `(0%)`。
- HTML 版 inline style（貼進 Word 才保得住）：`<span style="color:#8f5a06">(40%)</span>`、`<span style="color:#a82c26">暫停...(10%)</span>`——這裡**允許寫死色碼**，因為是輸出到外部文件，不是介面；值取自 token 表以免兩邊不一致。
- 預覽區同樣的著色用 class：`.rp-doing{color:var(--color-warning-text)}` `.rp-paused{color:var(--color-danger-text)}` `.rp-done{color:inherit}`。

其他三個模版只定版面骨架（內容邏輯由功能施工者照 R3 做）：
- **個人週報**：`# 週報 11/24–11/30 · 王小明` → `## 本週完成`（條列，含專案）→ `## 進行中`（條列＋進度）→ `## 下週預計`（本週到期但未完成＋下週到期）→ `## 需要協助`（被擋住的任務，寫「等待：X」）。
- **PL 匯報**：成員多選；`# 進度匯報 11/24–11/30` → 每位成員一節 `## 王小明`（頭像在預覽、不進文字）→ 節內照工作日誌格式分專案；最前面一段 `## 總覽`（每人：完成 N／進行中 N／逾期 N 的一行表格）。排序照成員名，不排名。
- **設計決議**：表格骨架 `| 議題 | 決議 | 負責人 | 期限 |`，來源＝範圍內**有「決議」或「設計」標籤／專案**的任務（規則由施工者定、寫進 `reportFormat.ts` 註解）；沒有符合的就顯示空表格＋說明「在任務標題或專案名稱加上『決議』會被收進來」。
- 以上四種的 `.md` 與 `.html` 下載檔名沿用 `reportFileName()`，加模版名：`工作日誌_2026-11-24_2026-11-30_王小明.md`。

**驗收**：在個人頁按「今日 ▾」，不動任何設定就能複製一段 `[專案] - 人名` 開頭、每條尾巴有 `(NN%)`／`_完成`／`暫停...(NN%)` 的文字，貼進 Google Docs 時進行中是橘字、暫停是紅字；按「匯報 ▾」預選個人週報；本週卡三個數字＝底下清單筆數。

---

## 7. 全站搜尋 Ctrl+K（U3、M1；新元件 `shell/CommandPalette`、新檔 `shell/cmdk.css`）

```
                 ┌──────────────────────────────────────────────────────┐
                 │ 🔍 搜尋任務、專案、成員…                        Esc  │  ← 48px 輸入列
                 ├──────────────────────────────────────────────────────┤
                 │ 任務                                                  │  ← .cmdk-group-label
                 │ ● 撰寫週報              量測系統 · 王小明 · 11/28  ↵ │  ← .cmdk-item（選中）
                 │ ● 週報模版整理          文件整理 · 未指派            │
                 │ 專案                                                  │
                 │ ■ 量測系統              12 個任務                     │
                 │ 成員                                                  │
                 │ (王) 王小明             @wang · 4 個進行中             │
                 ├──────────────────────────────────────────────────────┤
                 │ ↑↓ 移動   ↵ 開啟   Tab 切換分組   Esc 關閉            │  ← .cmdk-foot
                 └──────────────────────────────────────────────────────┘
                   寬 640、距頂 15vh、radius-xl、shadow-md、遮罩 --color-overlay
```

```html
<dialog class="cmdk" aria-label="全站搜尋">
  <div class="cmdk-input-row"><svg class="cmdk-icon"/><input class="cmdk-input" role="combobox" aria-expanded aria-controls="cmdk-list" aria-activedescendant="…" placeholder="搜尋任務、專案、成員…"><kbd class="ui-kbd">Esc</kbd></div>
  <div class="cmdk-list" id="cmdk-list" role="listbox">
    <div class="cmdk-group" role="group" aria-labelledby="g-tasks">
      <div class="cmdk-group-label" id="g-tasks">任務 <span class="cmdk-group-count">12</span></div>
      <div class="cmdk-item" role="option" aria-selected="true" id="r-t-12">
        <span class="cmdk-item-lead"><span class="ui-dot ui-dot--md" style="color:var(--color-status-doing)"></span></span>
        <span class="cmdk-item-title">撰寫<mark>週報</mark></span>
        <span class="cmdk-item-meta">量測系統 · 王小明 · 11/28</span>
        <kbd class="ui-kbd cmdk-item-kbd">↵</kbd>
      </div>
    </div>
    …專案、成員…
  </div>
  <div class="cmdk-foot">…鍵盤提示…</div>
</dialog>
```
```css
.cmdk{width:min(640px,calc(100vw - 32px));margin:15vh auto 0;padding:0;border:1px solid var(--color-border);border-radius:var(--radius-xl);
  background:var(--color-surface-raised);box-shadow:var(--shadow-md);overflow:hidden}
.cmdk::backdrop{background:var(--color-overlay)}
.cmdk-input-row{display:flex;align-items:center;gap:10px;height:48px;padding:0 16px;border-bottom:1px solid var(--color-border-subtle)}
.cmdk-icon{color:var(--color-text-tertiary)}
.cmdk-input{flex:1;min-width:0;height:100%;border:0;outline:0;background:none;font:inherit;font-size:var(--text-base);color:var(--color-text)}
.cmdk-list{max-height:min(420px,60vh);overflow-y:auto;padding:6px}
.cmdk-group + .cmdk-group{margin-top:4px}
.cmdk-group-label{display:flex;align-items:center;gap:6px;padding:8px 10px 4px;font-size:var(--text-2xs);font-weight:500;color:var(--color-text-tertiary)}
.cmdk-group-count{font-variant-numeric:tabular-nums}
.cmdk-item{display:grid;grid-template-columns:20px minmax(0,1fr) auto 24px;align-items:center;column-gap:10px;min-height:40px;padding:0 10px;border-radius:var(--radius-md);cursor:pointer}
.cmdk-item[aria-selected="true"]{background:var(--color-accent-soft)}
.cmdk-item[aria-selected="true"] .cmdk-item-title{color:var(--color-accent-text)}
.cmdk-item-lead{display:grid;place-items:center}
.cmdk-item-title{min-width:0;font-size:var(--text-sm);color:var(--color-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmdk-item-title mark{background:none;color:inherit;font-weight:600;text-decoration:underline;text-decoration-color:var(--color-accent);text-underline-offset:2px}
.cmdk-item-meta{font-size:var(--text-xs);color:var(--color-text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}
.cmdk-item-kbd{opacity:0}.cmdk-item[aria-selected="true"] .cmdk-item-kbd{opacity:1}
.cmdk-empty{padding:32px 16px;text-align:center;font-size:var(--text-sm);color:var(--color-text-tertiary)}
.cmdk-foot{display:flex;gap:16px;height:36px;align-items:center;padding:0 16px;border-top:1px solid var(--color-border-subtle);font-size:var(--text-2xs);color:var(--color-text-tertiary)}
.cmdk-foot kbd{margin-right:4px}
@media (max-width:767px){.cmdk{margin-top:8px;width:calc(100vw - 16px)}.cmdk-item-meta{display:none}.cmdk-foot{display:none}}
```

行為：
- 開：`Ctrl+K`／`⌘K`、頂欄搜尋入口、`/`（任務區外時；任務區內 `/` 仍聚焦 FilterBar）。關：Esc、點遮罩、選定後。
- 資料：任務（既有 `GET /api/tasks` 快取，前端比對標題與 `#id`；超過 2000 筆再考慮後端 `?q=`）、專案、成員（既有快取）。每組最多 6 筆，底下「查看全部 N 筆任務 →」帶 `?q=` 到清單頁。
- 空輸入時顯示「最近開啟」（localStorage 最近 8 筆任務）與「快速前往」（總覽／清單／看板／甘特圖／延遲鏈／個人清單）。
- 鍵盤：↑↓ 移動（跨組）、Enter 開啟（任務→`openTask(id)`；專案→清單頁 `?project=`；成員→`/me?user=`）、Tab／Shift+Tab 跳到下一組第一筆、Esc 關閉。`role=combobox`＋`aria-activedescendant`。
- 比對規則：不分大小寫、連續子字串優先、再分詞；`#12` 直接命中任務 id。高亮用 `<mark>`。
- M1 的「可存常用篩選」：**這一輪不做**（會動 FilterBar 與儲存格式），在 §10 列出。

**驗收**：任何頁按 Ctrl+K 出現浮層、打兩個字 150ms 內出結果、↑↓↵ 不碰滑鼠就能開到任務抽屜；Esc 關閉後焦點回到原本位置。

---

## 8. 討論區（U5、M3；`discussion.css`）

**維持列表式、不改成氣泡**（氣泡在 480px 寬的抽屜裡浪費寬度，而且討論串兩層結構用列表才看得出縮排）。只調可讀性：

| 項目 | 改前 | 改後 |
|---|---|---|
| 作者 `.disc-author` | `--text-sm` 500 | `--text-sm` **600**，`color: var(--color-text)` |
| 時間 `.disc-time` | tertiary（原色 3.3:1） | 隨 §1.1 變 4.7:1；格式維持相對時間、hover 絕對時間 |
| 內文 `.disc-body` | `--text-sm` 13/20 | **`--text-base` 14/22**（討論是要讀的長文，比表格大一號） |
| @提及 `.disc-mention` | accent-soft 底、accent-text、500 | 不改；提到自己 `--disc-mention--me` 底 `--color-warning-soft`、字 `--color-warning-text`、**加 1px `--color-warning-border`** |
| 同一人連續訊息 | 每則都有頭像＋名字 | **5 分鐘內同一作者的連續根訊息折成一組**：第二則起 `.disc-msg--cont` 不顯示頭像與名字（左側留 24px 空位），hover 時在空位顯示小時間。元件改動（§11 第二階段） |
| 日期分隔 `.disc-day`（新增） | 無 | 跨日時插一行：`display:flex;align-items:center;gap:8px;margin:10px 0 4px;font-size:var(--text-2xs);color:var(--color-text-tertiary)`，兩側 1px `--color-border-subtle` 線（同 `.disc-unread` 畫法，顏色中性）。文字「今天」「昨天」「11/24（一）」 |
| 未讀分隔 `.disc-unread` | accent 細線＋「未讀」 | 不改 |
| 訊息 hover 底 | surface-hover 60% | 不改；浮動工具列不改 |
| 輸入框 `.disc-composer` | 36px textarea＋36px 送出鈕 | 不改；送出鈕 `ui-btn--primary`，停用時 `--color-surface-active`；提示列「Enter 送出 · Shift+Enter 換行 · @ 提及成員」加上第三段 |
| 討論區標題 | 「討論 N」 | 不改 |

**驗收**：抽屜打開討論，不放大就能分出「誰說的」（名字比內文粗）、「說了什麼」（14px）、「提到我」（有邊框的暖色晶片）；連續訊息不會每則都重複頭像。

---

## 9. 設定頁預留「整合」區塊（U6、M5；`settings.css`、`SettingsPage`）

放在「帳號資訊」之後，加兩張卡：

```html
<section class="settings-card settings-card--muted" aria-labelledby="settings-integrations-title">
  <header class="settings-card-head">
    <h3 id="settings-integrations-title">整合 <span class="ui-badge">規劃中</span></h3>
    <p>這裡之後會放 AI 助理（例如幫你把本週任務整理成日誌草稿）與外部通知。目前還沒有接任何服務，開關都是停用的。</p>
  </header>
  <ul class="settings-int-list">
    <li class="settings-int-row">
      <div class="settings-int-main"><span class="settings-int-name">AI 助理</span><span class="settings-int-desc">用你的任務與討論產生日誌、週報草稿；資料不會離開這台伺服器，除非你在這裡設定外部服務。</span></div>
      <label class="settings-switch" aria-disabled="true"><input type="checkbox" disabled><span class="settings-switch-track"></span></label>
    </li>
    <li class="settings-int-row">…Webhook／通知（Slack、Email）…</li>
  </ul>
  <p class="settings-int-foot">後端設定點：<code>integrations</code>（見 docs/requirements-2026-11-26.md U6）。</p>
</section>

<section class="settings-card" aria-labelledby="settings-about-title">   <!-- H6：版本與署名 -->
  <header class="settings-card-head"><h3 id="settings-about-title">關於</h3></header>
  <dl class="settings-info">
    <div><dt>版本</dt><dd>v2.0.0 <span class="settings-about-dim">· 2026-11-26</span></dd></div>
    <div><dt>作者</dt><dd>周暘恩（ChouYangEn0401）</dd></div>
    <div><dt>原始碼</dt><dd><a class="tl-link" href="…">github.com/ChouYangEn0401/EasyTasksSheet</a></dd></div>
    <div><dt>更新紀錄</dt><dd><a class="tl-link" href="/CHANGELOG.md">CHANGELOG.md</a></dd></div>
  </dl>
</section>
```
```css
.settings-card--muted{background:var(--color-bg)}
.settings-card--muted .settings-card-head h3 .ui-badge{margin-left:8px;vertical-align:2px}
.settings-int-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.settings-int-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-top:1px solid var(--color-border-subtle)}
.settings-int-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.settings-int-name{font-size:var(--text-sm);font-weight:500;color:var(--color-text-secondary)}
.settings-int-desc{font-size:var(--text-xs);color:var(--color-text-tertiary)}
.settings-switch{position:relative;display:inline-block;width:36px;height:20px;flex:none}
.settings-switch input{position:absolute;opacity:0;inset:0;margin:0}
.settings-switch-track{position:absolute;inset:0;border-radius:var(--radius-full);background:var(--color-surface-active);border:1px solid var(--color-border)}
.settings-switch-track::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--color-surface);box-shadow:var(--shadow-xs)}
.settings-switch[aria-disabled="true"]{cursor:not-allowed;opacity:.7}
.settings-int-foot{margin:12px 0 0;font-size:var(--text-xs);color:var(--color-text-tertiary)}
.settings-about-dim{color:var(--color-text-tertiary)}
```
文字全部中文、語氣中性（「規劃中」而不是「即將推出」，因為沒有時程）。開關是真的 `disabled`，不接任何事件。`/api/health` 回的 `version`／`author` 就是「關於」卡的資料來源，不要再抄一份。

**驗收**：設定頁最下面看得到「整合（規劃中）」兩個停用開關與說明、「關於」卡的版本號＝`curl /api/health` 回的值。

---

## 10. 不改的東西（避免過度發揮）

1. **甘特圖**：11 月改版（gantt-polish.md）的所有樣式一行不動；只有 token 值變動（如 text-tertiary、陰影）會自然套上。
2. **資訊架構**：側欄項目與順序、任務區四個檢視、抽屜的區塊順序（標題 → 狀態 → 欄位 → 自訂欄位 → 相關任務 → 相依 → 描述 → 待辦清單 → 歷史 → 討論）。「相依」只改名與樣式，不搬位置。
3. **後端 API 與資料形狀**：不加端點、不改欄位（本週卡、Ctrl+K、匯報全部用既有查詢；§5.3 的 `?focus=` 是前端 query）。
4. **互動與鍵盤**：所有既有快捷鍵（N、/、G+x、[、Ctrl+Z、F6、D、Esc 順序）；清單 grid 方向鍵導覽；拖曳的 aria-live 播報。只新增 Ctrl+K／⌘K。
5. **動態**：`motion.css` 全部不動（toast、抽屜、列進出場、高亮）；reduced-motion 處理照舊。
6. **顏色語言**：單一藍強調；被擋＝琥珀不用紅；總覽不排名、不用紅橘標人（product-principles.md）；逾期紅只用在「日期事實」。
7. **不加**：深色模式、字型檔（維持系統字堆疊）、圖示庫替換、斑馬紋、圓角大於 12px、漸層、彩色大面積底。
8. **不做（留到下一輪）**：可儲存的常用篩選（M1 後半）、自訂欄位編輯體驗（M4）、PPT 檔直接產出、討論區表情反應、看板泳道。
9. **既有 class 名不改名**（`.tl-*`、`.kanban-*`、`.dl-*`、`.disc-*`、`.pl-*`），E2E 規格靠它們；本文件新增的 class 都是加法。例外：`dependency.css` 的 `.dep-section-group／.dep-subtitle` 被 §5.1 的新結構取代，E2E `data-testid="dep-section"／"dep-row"／"dep-self"` 保留。

---

## 11. 施工順序

### 第一階段：只改 CSS（低風險，先做，一個 commit 可跑）

| # | 檔 | 做什麼 | 依據 |
|---|---|---|---|
| 1 | `tokens.css` | `@theme` → `:root`；§1.1 改值；§1.3 補 `-border`、新增 `blocked／paused`；§1.4 `--text-2xs`、`--text-num`；§1.5 間距／圓角／陰影；`--drawer-width: 520px` | §0.1、§1 |
| 2 | `components.css` | §1.6 工具類；§2.4 空／錯／載入態；`.ui-status-badge` 加 `border-color: var(--status-border, transparent)`（`statusStyle()` 之後補 `--status-border`，CSS 先寫好 fallback） | §1、§2.4 |
| 3 | `shell.css` | §2.1 `.nav-section-label`、選中左緣條、`.nav-item-count`、`.sidebar-version`；§2.2 `.header-search` 樣式（元件下一階段）；§2.3 `.page-head` | §2 |
| 4 | `tasks.css` | §3.2 `.tl-status-dot`、`.tl-due` 三色（靠 `data-due`，屬性由元件補，CSS 先到位）、`.tl-progress*`、群組列字重與計數 | §3 |
| 5 | `kanban.css` | §4 圓角 lg、clamp 2、`.kanban-card-progress`、`.kanban-col-count`、拖曳浮層 md 陰影、目標欄虛線框 | §4 |
| 6 | `dependency.css`、`delayLink.css` | §3.3 `.dep-mark*`；§5.1 `.dep-chain*／.dep-row*` 新規則（舊規則保留到元件換完再刪）；§5.3 `.dl-chain-stats`、`.dl-badge--overdue`、`.is-focus`、圖例；琥珀全部換 `--color-status-blocked-*` | §5 |
| 7 | `discussion.css` | §8 作者 600、內文 base、`.disc-day`、提及邊框 | §8 |
| 8 | `personal.css` | §6.1 `.pl-week*`；§6.2 `.rp-*` | §6 |
| 9 | `settings.css` | §9 `.settings-card--muted`、`.settings-int-*`、`.settings-switch*` | §9 |
| 10 | 新檔 `cmdk.css` | §7 全部 | §7 |

每步跑一次既有 E2E（Python 版）確認沒有 selector 壞掉；視覺用 1280／1024／768 三個寬度各截一張對照。

### 第二階段：要動元件（照價值排序）

| # | 元件 | 做什麼 | 牽涉 |
|---|---|---|---|
| A | `DependenciesSection` | 改成 §5.1 的鏈結構：三段、每列五欄、「目前等待」標籤、逾期天數、「看整條鏈」連結；`DependencyBadge` 的 `BlockedLock` → `.dep-mark`（兩顆） | 只讀既有 `GET /api/tasks/:id/dependencies`；`depText.ts` 加 `overdueDays()`、`currentWaitId()` 純函式＋測試 |
| B | `PersonalPage` + 新 `WeekCard` | §6.1 本週卡（三欄＋數字＋前五筆）；頂部「匯報 ▾」「今日 ▾」 | 用既有 `useTasks` 與 `assignedRows`；`presetRange` 加 `today` |
| C | `ReportDialog` + `reportFormat.ts` | §6.2 模版分段鈕、預覽區、一鍵複製（plain+html）、下載 .md／.html、工作日誌格式與 `worklogState()`；另外三個模版骨架 | 純前端；`reportFormat.test.ts` 加工作日誌案例（完成／進行中／暫停／0%） |
| D | 新 `CommandPalette` + `Header` | §7 浮層與 §2.2 搜尋入口；QuickAdd 改成按鈕展開 | 全域快捷鍵表（`lib/shortcuts.ts`）加 Ctrl+K；`nav.ts` 提供「快速前往」清單 |
| E | `ListTable`／`model.ts`／`KanbanCard` | §3 progress 欄預設顯示、`.tl-status-dot`、列的 `data-due`；§4 進度條、欄標頭計數、名字 | `dueBucket(task, today)` 純函式放 `lib/format.ts`，三處共用（清單、看板、本週卡） |
| F | `lib/colors.ts` | `statusTone` 加 `paused`；`statusStyle` 多吐 `--status-border` | 影響所有 `StatusBadge`，先確認 `review` 判法不變 |
| G | `DelayLinkPage` | §5.3 摘要列、節點第三行、`?focus=`、折疊其他鏈 | `delayLinkLayout.ts` 的 `nodeHeight` +16，`delayLinkLayout.test.ts` 同步 |
| H | `DiscussionThread` | §8 同作者 5 分鐘內折疊、日期分隔 | `discussionModel.ts` 加 `groupMessages()` 純函式＋測試 |
| I | `Sidebar`、`SettingsPage` | §2.1 分組標題與版本列；§9 整合與關於卡 | 讀 `/api/health` |

### 第三階段：收尾

- 文件：本檔頭的「最後更新」、`docs/design/core-shell.md` §2 補一行「token 微調見 ui-refresh-2026-11-26.md」、`delay-link.md` §6 補指標；`CHANGELOG.md` 2.0.0 段落列 UI 改版項目（資料格式沒變、不必備份）。
- 全站對比抽查（§1 驗收）、三個寬度無水平捲軸、reduced-motion 開著跑一遍。

---

## 12. 附錄：一眼對照（施工者速查）

| 想畫 | 用 |
|---|---|
| 狀態點 | 8px 圓、`var(--status-dot)`；在線上的節點 10px 加 2px 白圈 |
| 狀態 pill | `.ui-status-badge`：`--status-soft` 底、`--status-text` 字、`--status-border` 1px 邊、高 22、full 圓角 |
| 數字泡泡 | 18px 高、full、`--color-surface-active` 底、`--text-2xs`、tabular |
| 逾期 | 文字 `--color-status-overdue-text`；pill 用 overdue 三件組；只用在**日期事實** |
| 今天到期 | 文字 `--color-warning-text`，寫「今天」 |
| 被擋／等待中／預計延後 | `--color-status-blocked-*`（琥珀），不用紅 |
| 暫停 | `--color-status-paused-*`；工作日誌裡的「暫停」尾巴用 `--color-danger-text`（那是使用者的格式，不是狀態色） |
| 選中 | `--color-accent-soft` 底＋左緣 `inset 2px 0 0 var(--color-accent)`（清單列、側欄）；卡片改邊框 accent |
| 進度條 | 高 4px（列、卡）／6px（抽屜）、full、底 `--color-surface-active`、填 `--status-dot` |
| 靜置陰影／浮層陰影 | `--shadow-xs`／`--shadow-md`（sm、lg 是別名） |
| 卡片圓角／浮層圓角 | `--radius-lg` 10／`--radius-xl` 12 |
| 小字 | `--text-2xs` 11/14（計數、分組標題、鍵盤提示） |

# 設計規格 — core/shell

適用分支：`core/shell`。本文件的 token 與基礎元件為**全專案基準**，之後各軌道設計稿一律引用此處的 CSS 變數名稱，不得自訂色碼或尺寸。

## 1. 視覺方向

- 淺色單一主題（不做深色）。頁面底為近白 `--color-bg`，內容面為純白 `--color-surface`，以 1px 邊框分層，陰影只用在浮層。
- **單一強調色**（藍 `--color-accent`）只用於：主要按鈕、目前選取的導覽 / 分頁、focus ring、連結。其餘一律中性灰階。
- 語意色（成功 / 警告 / 危險）與狀態色只以「淡底 + 深字」的小面積出現（Badge、提示列），不做大色塊。
- 留白：頁面內距 24px，區塊間距 24px，列高 40px；資訊密度適中，不用斑馬紋，列以 `--color-border-subtle` 分隔。
- 字體：系統字堆疊，數字用 `font-variant-numeric: tabular-nums`。圖示用單一線條風格（1.5px stroke，16 / 20px）。

## 2. 設計 token（`src/web/styles/tokens.css`，定義於 `:root`）

### 2.1 色彩 — 中性與強調

| 變數 | 值 | 用途 |
|---|---|---|
| `--color-bg` | `#F7F8FA` | 頁面底、側欄底 |
| `--color-surface` | `#FFFFFF` | 卡片、表格、抽屜、對話框 |
| `--color-surface-hover` | `#F3F4F6` | 列 / 導覽項 hover |
| `--color-surface-active` | `#E9EBEF` | 按下、已選取的中性項目 |
| `--color-border` | `#E3E5E9` | 一般邊框、輸入框 |
| `--color-border-subtle` | `#EEF0F2` | 列分隔線 |
| `--color-border-strong` | `#C9CDD4` | 輸入框 hover |
| `--color-text` | `#1C2024` | 主要文字 |
| `--color-text-secondary` | `#5B6370` | 次要文字、標籤 |
| `--color-text-tertiary` | `#8B929D` | 輔助說明、時間戳、placeholder |
| `--color-text-disabled` | `#B4B9C1` | 停用文字 |
| `--color-text-on-accent` | `#FFFFFF` | 強調色底上的文字 |
| `--color-accent` | `#2F6FEB` | 強調色 |
| `--color-accent-hover` | `#245BD0` | 主要按鈕 hover |
| `--color-accent-active` | `#1D4CB0` | 主要按鈕按下 |
| `--color-accent-soft` | `#EAF1FE` | 選取底色（導覽、分頁、選取列） |
| `--color-accent-text` | `#1F56C4` | 淡底上的強調文字、連結 |
| `--color-focus-ring` | `rgba(47,111,235,.35)` | focus 外框 |
| `--color-overlay` | `rgba(20,24,32,.40)` | Dialog / 抽屜遮罩 |

### 2.2 色彩 — 語意色（每組：`-text` 深字 / `-soft` 淡底 / `-border` 邊 / 本色）

| 語意 | 本色 | `-soft` | `-text` | `-border` |
|---|---|---|---|---|
| `--color-success` | `#1F9D61` | `#E7F6EE` | `#15734A` | `#BFE5D0` |
| `--color-warning` | `#D98A0B` | `#FDF3DF` | `#8F5A06` | `#F3D9A4` |
| `--color-danger` | `#D8433B` | `#FDECEA` | `#A82C26` | `#F4C4C0` |
| `--color-info` | `#2F6FEB` | `#EAF1FE` | `#1F56C4` | `#C3D6FA` |

變數全名範例：`--color-danger`、`--color-danger-soft`、`--color-danger-text`、`--color-danger-border`。

### 2.3 色彩 — 狀態色（對應 `statuses.category`，另含逾期）

| 變數前綴 | 點 / 本色 | `-soft` | `-text` | 對應 |
|---|---|---|---|---|
| `--color-status-todo` | `#8B929D` | `#F0F1F3` | `#4B5360` | 待辦 |
| `--color-status-doing` | `#2F6FEB` | `#EAF1FE` | `#1F56C4` | 進行中 |
| `--color-status-review` | `#8257D9` | `#F1EBFD` | `#5E3BB0` | 審查中（category 仍為 doing） |
| `--color-status-done` | `#1F9D61` | `#E7F6EE` | `#15734A` | 完成 |
| `--color-status-overdue` | `#D8433B` | `#FDECEA` | `#A82C26` | 逾期（日期文字） |

標籤 / 專案 / select 選項共用調色盤（8 色，各有本色與 `-soft`）：`--color-tag-gray|blue|purple|green|yellow|orange|red|teal`，值依序 `#8B929D #2F6FEB #8257D9 #1F9D61 #C99A0A #E0762A #D8433B #1A9BA8`；`-soft` 為該色混白 88%。DB 內的 `color` 欄位存調色盤鍵名（如 `blue`），不存色碼。

### 2.4 字級

字體：`--font-sans: "Inter", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`；`--font-mono: ui-monospace, "Cascadia Code", Consolas, monospace`。

| 變數 | 大小 / 行高 | 用途 |
|---|---|---|
| `--text-xs` | 12px / 16px | 時間戳、Badge、輔助說明 |
| `--text-sm` | 13px / 20px | 表格內文、導覽、按鈕、輸入框（**預設內文**） |
| `--text-base` | 14px / 22px | 段落、描述、表單內容 |
| `--text-lg` | 16px / 24px | 區塊標題、Dialog 標題 |
| `--text-xl` | 20px / 28px | 頁面標題 |
| `--text-2xl` | 24px / 32px | 登入頁標題、統計數字 |

字重：`--font-regular: 400`、`--font-medium: 500`、`--font-semibold: 600`。標題用 600，按鈕與導覽用 500。

### 2.5 間距、圓角、陰影、其他

| 類別 | 變數 = 值 |
|---|---|
| 間距（4px 基準） | `--space-1`=4、`--space-2`=8、`--space-3`=12、`--space-4`=16、`--space-5`=20、`--space-6`=24、`--space-8`=32、`--space-10`=40、`--space-12`=48（px） |
| 圓角 | `--radius-sm`=4px（Badge、checkbox）、`--radius-md`=6px（按鈕、輸入框、導覽項）、`--radius-lg`=10px（卡片、Dialog、選單）、`--radius-full`=9999px（Avatar、膠囊） |
| 陰影 | `--shadow-xs`: `0 1px 2px rgba(16,24,40,.05)`（按鈕、卡片）<br>`--shadow-sm`: `0 2px 6px rgba(16,24,40,.08)`（拖曳中卡片）<br>`--shadow-md`: `0 8px 24px rgba(16,24,40,.12)`（選單、Popover、Toast）<br>`--shadow-lg`: `0 16px 48px rgba(16,24,40,.18)`（Dialog、抽屜） |
| 控制項高度 | `--control-sm`=28px、`--control-md`=32px（預設）、`--control-lg`=40px（登入頁） |
| 版面 | `--sidebar-width`=232px、`--sidebar-width-collapsed`=56px、`--header-height`=52px、`--drawer-width`=480px、`--content-max`=1440px、`--row-height`=40px |
| 層級 | `--z-header`=10、`--z-sidebar`=20、`--z-drawer`=30、`--z-dialog`=40、`--z-popover`=50、`--z-toast`=60 |
| 動態 | `--duration-fast`=120ms（hover / 按下）、`--duration-base`=200ms（選單、抽屜）、`--ease-standard`=`cubic-bezier(.2,0,0,1)`；`prefers-reduced-motion` 時時長歸 0 |

Tailwind 設定將以上變數對應為 theme 值（如 `bg-surface`、`text-secondary`、`rounded-md`），元件內禁止寫死色碼。

## 3. 基礎元件（`src/web/ui`）

共通：focus-visible 一律 `outline: 2px solid var(--color-accent); outline-offset: 2px`（輸入框改為邊框變 accent + `0 0 0 3px var(--color-focus-ring)`）；停用為 `opacity` 不變、改用 disabled 色並 `cursor: not-allowed`；轉場 `--duration-fast`。

### Button
尺寸 `sm`(28) / `md`(32) / `lg`(40)，水平內距 12 / 12 / 16，`--text-sm` 500，`--radius-md`；可帶前置圖示（16px，間距 6px）；`iconOnly` 為正方形且必須有 `aria-label`。

| variant | 預設 | hover | active | disabled |
|---|---|---|---|---|
| `primary` | accent 底、白字、shadow-xs | accent-hover | accent-active | `--color-surface-active` 底、disabled 字 |
| `secondary` | surface 底、border、text | surface-hover、border-strong | surface-active | border-subtle、disabled 字 |
| `ghost` | 透明、text-secondary | surface-hover、text | surface-active | disabled 字 |
| `danger` | danger 底、白字 | 加深 8% | 加深 14% | 同 primary disabled |

載入中：寬度不變，文字換為 14px spinner + 原文字，`aria-busy`，不可點。

### Input / Textarea
高 32（`lg` 40），內距 0 10px，surface 底、1px border、`--radius-md`、`--text-sm`。placeholder 用 text-tertiary。狀態：hover → border-strong；focus → accent 邊框 + focus ring；錯誤 → danger 邊框，下方 `--text-xs` danger-text 訊息（`aria-describedby`）；disabled → bg 底、disabled 字；readonly → 無邊框、透明底。可帶前置圖示（搜尋）與尾端清除鈕。Label 在上方 `--text-sm` 500 text-secondary，間距 6px。

### Select（含下拉選單 Menu 的共用面板樣式）
觸發鈕外觀同 Input，右側 chevron 16px。面板：surface、border、`--radius-lg`、`--shadow-md`，內距 4px，最小寬同觸發鈕、最大高 320px 可捲動。選項高 32、內距 0 8px、`--radius-sm`；hover / 鍵盤游標 → surface-hover；已選 → 右側 accent 勾勾；disabled → disabled 字。選項可帶色點或 Avatar。超過 8 項時頂部出現搜尋輸入。空結果顯示「沒有符合的項目」。

### Dialog
置中，寬 `sm` 400 / `md` 520，surface、`--radius-lg`、`--shadow-lg`，遮罩 `--color-overlay`。結構：標題列（`--text-lg` 600 + 右上關閉鈕，內距 20 24）／內容（內距 0 24 20）／動作列（右對齊，次要在左、主要在右，內距 16 24，上緣 border-subtle）。確認型（刪除等）主要鈕用 `danger`。開啟時 focus 移入第一個可互動元素，focus trap，Esc 與點遮罩關閉（表單有未存內容時不因點遮罩關閉），關閉後 focus 回到觸發元素。

### Badge
高 20、內距 0 6px、`--radius-sm`、`--text-xs` 500。tone：`neutral`（surface-active 底 / text-secondary）、`accent`、`success`、`warning`、`danger`（各用對應 `-soft` 底 + `-text` 字），以及 tag 調色盤 8 色。可選前置 6px 色點。計數型用 `--radius-full`、最小寬 20。

### StatusBadge
Badge 的狀態版：`--radius-full`、高 22、內距 0 8px、前置 6px 圓點；顏色依 `status.category` 取 `--color-status-*`（名稱含「審查」或 color=`purple` 時用 review 色）。`interactive` 時為按鈕：hover 加 1px 同色 border、顯示 chevron，點擊開 Select 面板（由 T1 使用）。唯讀版不可聚焦。

### Avatar
圓形，尺寸 `xs` 20 / `sm` 24 / `md` 28 / `lg` 36。無圖片，顯示顯示名稱首字（中文取第一字，英文取首字母大寫），底色由 user id 對 tag 調色盤取模（用 `-soft` 底 + 本色加深字），`--text-xs` 600。未指派：虛線邊框圓 + 人形圖示，text-tertiary。hover 顯示名稱 tooltip。`AvatarGroup`：重疊 -6px、白色 2px 外框，超過 3 個顯示 `+N`。

### UpdatedAt
`--text-xs` text-tertiary、tabular-nums。顯示相對時間：`剛剛`（<1 分）、`N 分鐘前`、`N 小時前`、`昨天`、`N 天前`（<7 天）、其後 `MM/DD`、跨年 `YYYY/MM/DD`。hover / focus 顯示 tooltip：`2026/11/24 14:32 · 由 王小明 更新`（無修改者時省略後半）。使用 `<time datetime>`，每 60 秒自行重算。props：`at`、`by?`、`prefix?`（如「更新於」）。

### Toast（僅預留樣式，行為由 T9 實作）
容器固定右下，距邊 24px，`--z-toast`，由下往上堆疊、間距 8px。單則：寬 360、surface、border、`--radius-lg`、`--shadow-md`、內距 12 16；左側 20px 語意圖示（success / danger / info / warning 本色），標題 `--text-sm` 500、說明 `--text-sm` text-secondary，右側可有一個 ghost 動作鈕與關閉鈕。core 只提供 `Toast` 外觀元件與 `.toast-viewport` 樣式，不提供佇列邏輯。

### 其他小元件
- **Checkbox**：16px、`--radius-sm`；勾選為 accent 底白勾；hover border-strong；disabled 灰。
- **Tooltip**：`#1C2024` 底、白字、`--text-xs`、內距 4 8、`--radius-sm`，延遲 400ms，鍵盤 focus 亦顯示。
- **Spinner**：16 / 20px，accent 色 2px 環。**Skeleton**：surface-active 底、`--radius-sm`、淡入淡出脈動 1.2s。
- **EmptyState**：置中，40px 線條圖示（text-tertiary）、標題 `--text-base` 500、說明 `--text-sm` text-secondary、可選一個主要按鈕；上下留白 48px。
- **ErrorState**：同版型，圖示用 danger 色，文案「載入失敗」+ 錯誤訊息 + 「重試」secondary 按鈕。
- **Placeholder 頁**（各 feature 未實作時）：EmptyState，標題為頁面名稱，說明「此功能開發中」。
- **Kbd**：`--font-mono` `--text-xs`、bg 底、border、`--radius-sm`、內距 0 4px。

## 4. AppShell 版面

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ ◆ TasksSheets│ 頁面標題                    [🔍 快速新增…  N]   (頭像 ▾) │ ← Header 52px
│              ├──────────────────────────────────────────────────────────┤
│ ▢ 總覽       │ ViewTabs（僅任務區）                                      │
│ ▢ 任務     ▾ │ FilterBar（僅任務區）                                     │
│    List      │──────────────────────────────────────────────────────────│
│    Kanban    │                                                          │
│    Gantt     │   頁面內容（內距 24px，可垂直捲動）                       │
│ ▢ 問題回饋   │                                                          │
│ ▢ 個人清單   │                                                          │
│ ▢ 工程追蹤   │                                                          │
│ ──────────── │                                                          │
│ ▢ 成員管理*  │                                                          │
│              │                                                          │
│ [« 收合]     │                                                          │
└──────────────┴──────────────────────────────────────────────────────────┘
  Sidebar 232px                                    * 僅 role=admin 顯示
```

### 4.1 Sidebar
- 底 `--color-bg`，右緣 1px border；固定不隨內容捲動。頂部品牌列高同 Header：16px 強調色標誌 + 「TasksSheets」`--text-base` 600。
- 導覽項：高 32、內距 0 10px、左右外距 8px、`--radius-md`、圖示 16px + 文字 `--text-sm` 500 text-secondary，間距 10px。

| 入口 | 路由 | 圖示語意 | 備註 |
|---|---|---|---|
| 總覽 | `/` | 儀表 | 登入後預設頁 |
| 任務 | `/tasks/list` | 清單勾選 | 可展開群組；點群組標題進入上次使用的檢視（預設 List） |
| └ List | `/tasks/list` | — | 子項縮排 26px，無圖示 |
| └ Kanban | `/tasks/kanban` | — | |
| └ Gantt | `/tasks/gantt` | — | |
| 問題回饋 | `/feedback` | 對話框 | |
| 個人清單 | `/me` | 人像 | |
| 工程追蹤 | `/eng` | 分支 | |
| 成員管理 | `/admin/users` | 齒輪人像 | 分隔線下方；非管理員不渲染 |

- 狀態：預設（透明）／hover（surface-hover、text）／**選取**（accent-soft 底、accent-text 字與圖示、500）／focus-visible（focus outline）。任務群組在其子路由下自動展開，群組標題本身不套選取底、只將文字轉為 `--color-text`。
- 底部「收合」ghost 鈕：收合後寬 56px，只留圖示，文字改以 tooltip 顯示；任務子項收合時改為 hover 浮出選單。收合狀態存 `localStorage`。
- 導覽以 `<nav aria-label="主要導覽">` 與 `aria-current="page"` 標示。

### 4.2 Header
- 高 52、surface 底、下緣 1px border、內距 0 24px。
- 左：頁面標題 `--text-lg` 600（由路由 meta 提供）。
- 右（由左至右，間距 12px）：全域 QuickAdd 入口（見 §7.1）、使用者選單觸發鈕。
- 使用者選單觸發：Avatar `md` + 顯示名稱 `--text-sm` + chevron，ghost 樣式。面板（寬 220，Menu 樣式）：
  1. 頂部資訊（不可點）：顯示名稱 500、`@username` text-tertiary、管理員另有 `accent` Badge「管理員」
  2. 分隔線
  3. 「變更密碼」→ 開啟 Dialog
  4. 「登出」（danger-text 字）→ 立即登出並導向 `/login`

### 4.3 變更密碼 Dialog
`sm` 寬。欄位：目前密碼、新密碼（下方說明「至少 8 個字元」）、確認新密碼；密碼欄尾端有顯示 / 隱藏切換。主要鈕「更新密碼」，欄位未填齊或兩次不一致時停用並於確認欄顯示錯誤。API 錯誤顯示在表單上方的 danger-soft 提示列。成功後關閉並顯示頁內成功提示列（T9 前不依賴 Toast）。
**強制變更版**（`must_change_password`）：改為整頁（沿用登入頁版型），無關閉鈕、無遮罩關閉、Esc 無效，標題「請先設定新密碼」，只提供「更新密碼」與「登出」。預設管理員（`admin` / `password`）首次登入時改為「請設定新帳號與新密碼」，表單最上方多一個「新帳號」欄位（預填 `admin`，須改成其他帳號，錯誤顯示在該欄位），按鈕為「更新帳號與密碼」。

### 4.4 全域狀態畫面
- 首次載入 `me`：整頁置中 Spinner。
- Session 過期（401 / 閒置逾時 / 9 小時到期）：導向 `/login?reason=expired&next=<原路徑>`，登入頁顯示 info 提示列「登入已逾時，請重新登入」。
- 404：EmptyState「找不到頁面」+「回到總覽」。
- 網路錯誤：內容區頂部 warning-soft 提示列「連線中斷，正在重試…」，恢復後自動消失。

## 5. 登入頁（`/login`）

```
              （頁面底 --color-bg，垂直水平置中）
            ┌────────────────────────────────┐
            │  ◆ TasksSheets                 │
            │  登入                          │  ← --text-2xl 600
            │  實驗室專案管理工具             │  ← --text-sm text-secondary
            │                                │
            │  [提示列：錯誤 / 逾時 / 鎖定]   │
            │  帳號                          │
            │  [______________________]      │
            │  密碼                          │
            │  [__________________ 👁]       │
            │  [        登入         ]       │  ← primary lg，滿寬
            └────────────────────────────────┘
               卡片寬 380、內距 32、radius-lg、border、shadow-xs
```

- 輸入框用 `lg`(40)。進頁自動 focus 帳號欄；Enter 送出；`autocomplete="username"` / `"current-password"`。
- 狀態：預設／送出中（按鈕 loading、欄位停用）／錯誤 401（danger-soft 提示列「帳號或密碼不正確」，清空密碼並 focus 密碼欄，**不區分帳號是否存在**）／鎖定 429（warning-soft 提示列「嘗試次數過多，請於 N 分鐘後再試」，按鈕停用至可重試）／逾時導回（info-soft 提示列）／網路錯誤（danger-soft「無法連線到伺服器」）。
- 提示列樣式：對應 `-soft` 底、`-border` 邊、`-text` 字，`--radius-md`、內距 8 12、`--text-sm`，`role="alert"`。
- 已登入者進入 `/login` 直接導向 `next` 或 `/`。無註冊、無忘記密碼連結；卡片下方 `--text-xs` text-tertiary「忘記密碼請洽管理員」。

## 6. 任務區共用：ViewTabs 與 FilterBar

位於任務三個檢視頁的內容區頂部，兩列皆 surface 底、左右內距 24px，FilterBar 下緣 1px border，捲動時黏在頂部（`position: sticky`）。

### 6.1 ViewTabs
```
 [≡ List]  [▥ Kanban]  [▤ Gantt]                              （右側保留插槽）
 ────────
```
- 列高 44。分頁項：圖示 16 + 文字 `--text-sm` 500，內距 0 12px，項間距 4px。
- 狀態：預設 text-secondary／hover text + surface-hover 底（`--radius-md`）／**選取** accent-text + 底部 2px accent 線／focus-visible outline。
- 為路由連結（`<a>`），切換時**保留目前 query string**（篩選不重置）。`role="tablist"` 不採用，改用 `<nav aria-label="任務檢視">` + `aria-current`。
- 右側 `actions` 插槽供各檢視放自己的控制項（分組、時間刻度等）。

### 6.2 FilterBar
```
 [🔍 搜尋任務…        ] [專案 ▾] [負責人 ▾] [狀態 ▾]   清除篩選        共 42 筆
```
- 列高 48，控制項 `md`(32)，間距 8px。搜尋框寬 240（focus 時不變寬）。
- 專案 / 負責人 / 狀態皆為**多選** Select（面板內選項前有 Checkbox，負責人含「未指派」，選項帶色點 / Avatar）。
- 觸發鈕狀態：未設定 → secondary 外觀、顯示欄名；已設定 → accent-soft 底、accent-border（`--color-info-border`）、accent-text，文字為 `狀態：進行中`，多個時 `狀態：進行中 +1`。
- 有任一篩選時才顯示「清除篩選」ghost 鈕。右側結果數 `--text-xs` text-tertiary（載入中顯示 Skeleton）。
- URL 參數：`q`、`project`、`assignee`、`status`（多值以逗號分隔，`assignee=none` 表未指派）。搜尋輸入 debounce 300ms 後以 `replace` 寫入 URL；下拉變更立即寫入。重新整理、分享連結、切換檢視皆保留。
- 篩選後無結果：內容區顯示 EmptyState「沒有符合條件的任務」+「清除篩選」按鈕。

## 7. 插槽元件最小版

### 7.1 QuickAdd（`features/tasks/QuickAdd.tsx`）
- 外觀：Input（寬 280，Header 內；其他引用處可傳 `fullWidth`），前置「+」圖示，placeholder「新增任務，按 Enter 建立」，尾端顯示 `Kbd` 提示 `N`（focus 後隱藏）。
- 行為：輸入標題 → Enter 建立（只送 `title`，可由 props 帶 `defaults` 如 `status_id`、`project_id`）→ 成功後清空並**保持 focus** 以連續新增；空白或僅空白字元時 Enter 無作用；Esc 清空並失焦。
- 狀態：預設／focus／送出中（尾端 Spinner，輸入框唯讀，約 <300ms）／成功（尾端綠色勾勾 1.2 秒，並在輸入框下方以 `--text-xs` success-text 顯示「已建立」；`aria-live="polite"`）／失敗（danger 邊框 + 下方錯誤訊息，保留輸入內容）。
- 建立成功即 invalidate 任務查詢，不需重整。

### 7.2 TaskDrawer（`features/tasks/TaskDrawer.tsx`，`openTask(id)` 寫入 `?task=<id>`）
```
                                   ┌─────────────────────────────────────┐
                                   │ #128                        [✕]    │ ← 標題列 52px
                                   │ 任務標題（--text-xl 600，可換行）   │
                                   │ ● 進行中                            │
                                   │─────────────────────────────────────│
                                   │ 負責人    (頭像) 王小明             │
                                   │ 專案      ● 預設專案                │
                                   │ 開始日    2026/11/20                │
                                   │ 到期日    2026/11/28                │
                                   │ 預估工時  6 小時                    │
                                   │ 進度      ▓▓▓▓░░░░ 40%              │
                                   │─────────────────────────────────────│
                                   │ 描述                                │
                                   │ （純文字，保留換行；空值顯示「—」）  │
                                   │─────────────────────────────────────│
                                   │ 更新於 3 小時前 · 由 李大華          │ ← 頁尾，UpdatedAt
                                   └─────────────────────────────────────┘
                                     右側滑入，寬 --drawer-width (480)
```
- 容器：自 Header 下緣到視窗底，surface、左緣 border、`--shadow-lg`、`--z-drawer`；**不加遮罩**，背景頁面仍可操作（點其他任務即切換內容）。內距 24px，內容區可捲動，標題列與頁尾固定。
- 欄位列：兩欄（標籤 96px text-secondary `--text-sm`／值 `--text-sm`），列高 32；空值顯示「—」text-tertiary；逾期的到期日用 `--color-status-overdue-text`。進度條高 6、`--radius-full`、底 surface-active、填色 accent。
- 最小版**全部唯讀**，自訂 property 不顯示；預留 `PinButton` 位置於標題列關閉鈕左側（core 版回傳 null，不佔位）。
- 狀態：載入（標題與欄位 Skeleton）／錯誤（ErrorState + 重試）／找不到或已刪除（EmptyState「此任務不存在或已被刪除」+「關閉」）。
- 關閉：✕、Esc，或移除 `?task` 參數（瀏覽器上一頁亦可關閉）；關閉後 focus 回到觸發元素。`role="dialog"` `aria-modal="false"` `aria-labelledby` 指向標題。

## 8. 互動與鍵盤操作

| 按鍵 | 作用 |
|---|---|
| `Tab` / `Shift+Tab` | 依視覺順序移動：跳至內容連結 → Sidebar → Header → 內容 |
| `N` | 聚焦 Header 的 QuickAdd（focus 在輸入框 / 可編輯區時不觸發） |
| `/` | 聚焦 FilterBar 搜尋框（僅任務區，同上限制） |
| `G` 然後 `O` / `L` / `K` / `G` / `F` / `M` / `E` | 前往 總覽 / List / Kanban / Gantt / 問題回饋 / 個人清單 / 工程追蹤 |
| `[` | 收合 / 展開 Sidebar |
| `Esc` | 依序關閉最上層：Popover → Dialog → TaskDrawer；在輸入框內則先清空 / 失焦 |
| `Enter` / `Space` | 啟動按鈕、開啟選單、勾選 Checkbox |
| `↑` `↓` `Home` `End` | 在 Select / Menu 面板內移動；直接輸入文字可跳至相符選項 |
| `Enter`（面板內） | 選取；多選面板不關閉，單選面板選取後關閉 |

- 頁面最前方提供隱藏的「跳至主要內容」連結（focus 時顯示）。
- 所有可互動元素皆可鍵盤操作並有可見的 focus 樣式；純圖示按鈕必有 `aria-label` 與 tooltip。
- 點擊目標最小 28×28px（768px 寬度下導覽項與主要按鈕 ≥ 36px 高）。
- 閒置偵測：`pointerdown` / `keydown` / `wheel` 視為操作，節流後每 5 分鐘最多送一次 heartbeat；逾時即清除快取並導向登入頁（提醒對話框由 T9 加入，core 不做）。
- 資料新鮮度：視窗 focus 重抓與 30 秒輪詢時**不顯示全頁載入**，僅保留既有內容靜默更新。

## 9. 響應式

| 寬度 | 版面 |
|---|---|
| ≥ 1280px | 完整版面：Sidebar 展開 232px，內容區內距 24px，內容最大寬 `--content-max` 置左延展；TaskDrawer 480px 與內容並存 |
| 1024–1279px | 同上，但 Sidebar **預設收合**為 56px（可手動展開，展開時推擠內容）；Header QuickAdd 寬縮為 220px |
| 768–1023px | Sidebar 固定收合 56px，展開時改為**覆蓋式**（浮在內容上，帶 `--color-overlay` 遮罩，選取後自動收回）；Header 的使用者名稱隱藏只留 Avatar；QuickAdd 寬 180px；內容內距改 16px；FilterBar 允許換行（搜尋框獨佔第一列滿寬，下拉在第二列）；ViewTabs 維持單列；TaskDrawer 寬 `min(480px, 100vw - 56px)` 並加遮罩（此寬度下視為 modal） |
| < 768px | 不在支援範圍，僅需不產生水平捲軸：Sidebar 完全隱藏改由 Header 左側漢堡鈕開啟覆蓋式選單；登入卡片寬 `calc(100vw - 32px)` |

- 內容區一律 `min-width: 0`，表格類內容自行在區塊內水平捲動，不得撐破 shell。
- 登入頁於所有寬度皆置中，卡片最大寬 380px。

## 10. 給實作者的檢查清單

1. `tokens.css` 完整定義 §2 全部變數，Tailwind theme 對應之；元件中搜尋不到任何寫死的色碼。
2. `src/web/ui` 匯出：Button、Input、Textarea、Select、Menu、Dialog、Badge、StatusBadge、Avatar、AvatarGroup、UpdatedAt、Checkbox、Tooltip、Spinner、Skeleton、EmptyState、ErrorState、Kbd、Toast（僅外觀）。
3. Sidebar 六個頂層入口與三個任務子項皆可進入 placeholder 頁；非管理員看不到成員管理。
4. FilterBar 狀態完全由 URL 驅動；ViewTabs 切換保留 query。
5. QuickAdd 可連續新增；TaskDrawer 由 `?task=<id>` 驅動並可用 Esc / 上一頁關閉。
6. 1280px 與 768px 兩個寬度逐頁檢查無水平捲軸、無重疊。

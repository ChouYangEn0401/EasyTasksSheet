# 前端架構（2.0 起：原生 JS、無建置）

> 📐 規範｜讀者：要改前端的人（人與 AI agent）｜10 分鐘
> 建立：2026-11-26｜最後更新：2026-11-26
> 脈絡：[requirements-2026-11-26.md](requirements-2026-11-26.md)（「整個系統只剩 Python」）、[CHANGELOG.md](../CHANGELOG.md) 2.0.0。

## 0. 一句話

瀏覽器直接載入 `web/static/js/` 底下的**原生 ES modules**，畫面用 **Preact 10**（隨附在 repo 裡，唯一的第三方前端套件）。
**沒有 Node.js、沒有 npm、沒有建置步驟、沒有 TypeScript**：改了檔案，重新整理就生效。
伺服器（`python main.py`，同一個 Python 行程）負責把 `web/` 送給瀏覽器。

## 1. 目錄

```
web/
  index.html                 頁面模板：<link> 所有 CSS、import map、載入 js/main.js
  static/
    js/
      main.js                入口：render(<App/>)
      App.js                 QueryClientProvider + RouterProvider + 全域掛載
      routes.js              全部路由（createBrowserRouter，basename = BASE_PATH）
      features/<功能>/       每個頁面一個資料夾：頁面元件、api.js（fetch 與 query hooks）、model.js（純邏輯）
      shell/                 外框：AppShell、Sidebar、Header、FilterBar、RequireAuth、nav.js（導覽項目）
      ui/                    基礎元件（Button、Dialog、Select…；index.js 統一匯出）
      lib/                   共用：api.js、auth.js、sync.js（SSE）、permissions.js（useCan）、base.js（BASE_PATH）…
                             以及三個自寫的小型替代品：query.js、router.js、dnd.js（見 §4）
      shared/                常數與名稱表（permissions.js 須與後端一致；pytest 會比對）
    css/
      base.css               @layer 順序宣告與 reset（第一個載入）
      tokens.css             設計 token（色、字級、間距、圓角、陰影）
      components.css / shell.css / motion.css / utilities.css
      features/<功能>.css    每個功能一份
    vendor/preact/           preact.module.js、hooks.module.js、compat.module.js、LICENSE（MIT）、README.md
```

目錄結構與 1.x 的 `src/web/` 一一對應：`src/web/features/eng/EngPage.tsx` → `web/static/js/features/eng/EngPage.js`；`src/shared/x.ts` → `web/static/js/shared/x.js`；各元件旁的 `.css` 集中到 `web/static/css/features/`。**`docs/design/` 裡還寫著 `src/web/…tsx` 的地方，照這個規則換成 `web/static/js/…js` 讀即可**（設計規格本身沒變）。

## 2. `index.html` 模板與版本化路徑

`web/index.html` 不是靜態檔，是**模板**。伺服器（`server/app/app.py` 的 `_mount_spa`）每次回這一頁時代入兩個值：

| 佔位 | 代入 | 用途 |
| ---- | ---- | ---- |
| `{{BASE}}` | `.env` 的 `BASE_PATH`（根目錄為空字串，子路徑例如 `/easytasks`） | 寫進 `<meta name="ts-base">`，`lib/base.js` 讀出來給 API 網址與路由 basename |
| `{{STATIC}}` | `{BASE}/static/v/<版本>` | 所有 CSS、JS、vendor 的網址前綴 |

- **版本**是 `web/static/` 底下所有檔案（相對路徑、大小、修改時間）的雜湊。檔案一變網址就變，舊快取自然失效。
- `/static/v/<版本>/...` 回一年 `immutable` 快取；`index.html` 一律 `no-cache`。模組之間用**相對路徑** import，自然都落在同一個版本段底下。
- `/static/...`（沒有版本段）也能開，回 `no-cache`，給人除錯用。`/static/` 底下找不到的檔回 404（不會回 `index.html`，否則瀏覽器只會報難懂的 MIME 錯誤）。其他路徑一律回 `index.html`（SPA 路由）。
- **開發模式**每次回 `index.html` 都重算版本 → 改了 JS／CSS 重新整理就生效。**正式模式**（`--prod`／`APP_ENV=production`）只在啟動時算一次 → 改檔要重啟服務。
- `BASE_PATH` 改了**只要重啟**（1.x 時寫死在建置產物裡，要重新建置）。

## 3. import map 與 Preact

`index.html` 的 import map 只定義三個裸模組名，程式碼裡**只准**用這三個（`server/tests/test_web_modules.py` 會擋）：

```json
{ "preact": ".../vendor/preact/preact.module.js",
  "preact/hooks": ".../vendor/preact/hooks.module.js",
  "preact/compat": ".../vendor/preact/compat.module.js" }
```

- 元件寫法是 `createElement`（沒有 JSX，因為沒有建置）。1.x 的 JSX 都已轉成 `createElement(Tag, props, ...children)`，每個元件檔開頭 `import { createElement, Fragment } from 'preact'`。
- React 專屬的東西（`forwardRef`、`createPortal`、`memo`、`useId`…）從 `preact/compat` 拿；一般 hooks 從 `preact/hooks` 拿。
- 樣式不在 JS 裡 import：在 `index.html` 用 `<link>` 列（順序：全域在前、`features/` 在後；layer 順序宣告在 `base.css`）。

### 更新 vendor（Preact）

1. 從 npm registry 下載新版 tgz（`https://registry.npmjs.org/preact/-/preact-<版本>.tgz`，任何電腦用瀏覽器或 curl 都行，不需要裝 Node）。
2. 解開後取 `dist/preact.module.js`、`hooks/dist/hooks.module.js`、`compat/dist/compat.module.js`，**原封不動**蓋掉 `web/static/vendor/preact/` 的三個檔。
3. 更新同目錄 `README.md` 的版本與 sha256（`sha256sum *.module.js`），`LICENSE` 一併換新。
4. 跑 §6 的三道防線。只升 Preact 10.x 的小版本；跳大版本前先讀 Preact 的遷移說明。

## 4. 為什麼不用框架，以及三個自寫的替代品

1.x 用了 react-query、react-router、dnd-kit 三個大型套件。它們都需要建置（npm 套件、相依樹、JSX）。要「不需要 Node」，只有兩條路：用 CDN（執行時依賴外網、版本與供應鏈不受控）或自己寫。我們只用到每個套件的一小部分，所以**各寫一個子集相容的替代品**：匯出名稱、參數形狀、行為照原套件，呼叫端只換了 import 來源。好處是零相依、可讀、可除錯；代價是只有專案用到的功能，要新功能得自己加。

| 檔案 | 取代 | 介面概要（只列主要的） | 刻意不做的 |
| ---- | ---- | ---------------------- | ---------- |
| `lib/query.js` | `@tanstack/react-query` v5 | `QueryClient`（`getQueryData`／`setQueryData`／`invalidateQueries`／`cancelQueries`…）、`QueryCache`、`MutationCache`、`QueryClientProvider`、`useQueryClient`、`useQuery`、`useInfiniteQuery`、`useMutation`、`keepPreviousData`、`focusManager`、`onlineManager` | networkMode（永遠視為 online）、suspense、persister／hydration、mutation scope、notifyManager 批次 |
| `lib/router.js` | `react-router` v7 | `createBrowserRouter(routes, { basename })`、`RouterProvider`、`Outlet`、`Navigate`、`Link`、`NavLink`、`useLocation`、`useNavigate`、`useParams`、`useSearchParams`、`useMatches`、`matchRoutes`（另有 `createPath`／`parsePath`／`resolvePath`） | loader／action／data API、自動捲到頂 |
| `lib/dnd.js` | `@dnd-kit/core`／`sortable`／`utilities` | `DndContext`、`DragOverlay`、`useDraggable`、`useDroppable`、`useSensor(s)`（Pointer／Mouse／Touch／Keyboard）、`closestCenter` 等碰撞函式、`SortableContext`、`useSortable`、`arrayMove`、`CSS.Transform`；以原生 **Pointer Events** ＋鍵盤實作（不用 HTML5 原生 DnD：它沒有鍵盤操作、不能自訂浮層） | 自動捲動、放下後的 FLIP 滑動動畫、`animateLayoutChanges` |

每個檔案開頭的註解寫了完整的差異清單；改它們之前先讀那段。三個檔都只准 import `preact`、`preact/hooks`、`preact/compat`。

其他 1.x 的小套件（zod、date-fns 等）直接拿掉：日期用 `lib/format.js` 的小函式，資料驗證以後端 pydantic 為準。

## 5. 新增一頁

1. **後端**先有 API（`server/app/features/<name>.py`，見 [HANDOFF.md §13](HANDOFF.md#13-如何擴充)）。
2. 建 `web/static/js/features/<name>/`：
   - `api.js`：`api.get/post/...`（`lib/api.js`）＋ `useQuery`／`useMutation`（`lib/query.js`）；查詢鍵放 `lib/queryClient.js` 的 `queryKeys` 或以功能名開頭。
   - `<Name>Page.js`：頁面元件，開頭 `import { createElement, Fragment } from 'preact'`，用 `ui/` 的基礎元件。
   - `model.js`：純邏輯（排序、分組、格式），方便日後測試。
3. 在 `web/static/js/routes.js` 加一筆路由（`{ path: '<name>', element: createElement(<Name>Page, null), handle: h('標題') }`）；要出現在側欄就在 `shell/nav.js` 的 `NAV_ENTRIES` 加一項，依 capability 用 `useCan()` 決定顯示。
4. 樣式寫 `web/static/css/features/<name>.css`，在 `web/index.html` 的 feature CSS 區加一行 `<link rel="stylesheet" href="{{STATIC}}/css/features/<name>.css" />`。顏色、間距一律用 `tokens.css` 的變數。
5. 有即時同步需求：後端寫入記 `record_change`，前端在 `lib/sync.js` 的 `ENTITY_QUERY_KEYS` 登記要重抓的查詢鍵。
6. 加 E2E：`tests/e2e/test_<name>.py`（Python 版 Playwright，帳號用 `server/e2e_setup.py` 的 `E2E_USERS`）；`test_smoke.py` 的 `ROUTES` 加上新路由。
7. 跑 §6 的三道防線。

所有相對 import 都要寫**完整檔名含 `.js`**（瀏覽器不會幫你補副檔名）。

## 6. 沒有型別檢查之後：三道防線

1.x 靠 `tsc --noEmit`、eslint、vitest 抓錯。2.0 拿掉了它們，改成：

1. **連結檢查** `server/tests/test_web_modules.py`（跟著 `python -m pytest server` 一起跑，幾秒）：每個相對 import 指到的檔存在、具名匯入在對方真的有 export（追 `export * from`）、裸模組名只允許 import map 那三個、不得殘留 `.ts`、`react`、`@tanstack`、`@dnd-kit`、`zod`、`date-fns`、`import.meta`。抓「打錯檔名、改名沒改完、刪了 export 還有人用」。
2. **全模組載入** `tests/e2e/test_smoke.py`：瀏覽器真的 `import()` 每一個 `web/static/js/**/*.js`（抓語法錯誤、循環依賴在載入時炸掉、執行期才發現的名字錯誤），再以 admin 登入走訪所有路由，console error 與 pageerror 必須為零。
3. **E2E**（`tests/e2e/`，Python 版 Playwright）：照 1.x 的規格逐支移植，驗行為。

```bash
.venv/bin/python -m pytest server -q       # 1
.venv/bin/python -m pytest tests/e2e -q    # 2 + 3（先 scripts/install.py --dev、playwright install chromium）
```

型別錯誤（傳錯欄位名、`undefined` 當物件用）這三道只能在**跑到那段程式**時抓到，所以：改共用函式的參數形狀時，grep 所有呼叫端；寫純邏輯時在檔頭用 JSDoc 註明參數形狀。

## 7. 這次轉換是怎麼做的（2026-11-26）

起點是 commit **a5ce7ac**（1.x 最後一版，React 18 + Vite + TypeScript，`src/web`、`src/shared`）。

1. **機械轉換**（一次性腳本，不進 repo）：
   - `.ts`：用 Node 內建的「去型別」（`stripTypeScriptTypes`，mode `strip`）只拿掉型別標註，程式碼位置不動。
   - `.tsx`：用 TypeScript 編譯器的 `transpileModule`，`jsx: React`、`jsxFactory: createElement`、`jsxFragmentFactory: Fragment`、target ES2022，保留註解與空行；每檔開頭補 `import { createElement, Fragment } from 'preact'`。
   - import 路徑 `.ts(x)` → `.js`；`react`／`react-dom` → `preact/compat`；`@tanstack/react-query` → `lib/query.js`、`react-router` → `lib/router.js`、`@dnd-kit/*` → `lib/dnd.js`；元件裡的 `import './x.css'` 拿掉、改列進 `index.html`；`src/shared` 搬到 `js/shared` 並修正相對路徑；拿掉 eslint 註解與只剩型別的空 import。
   - `*.test.ts` 不轉（vitest 移除）。
2. 手寫 `lib/query.js`、`lib/router.js`、`lib/dnd.js`，Preact 10.29.8 放進 `web/static/vendor/preact/`（來源與 sha256 見該目錄 README）。
3. 用 1.x 的 E2E 規格逐區驗收、修正轉換後的差異，再把 E2E 移植成 Python 版。
4. 刪除 `package.json`、`node_modules`、`vite.config.ts`、`tsconfig.json`、eslint／prettier 設定、`src/`；部署腳本去掉 Node（`ensure-node.ps1` 刪除）。

所以 `web/static/js/` 的程式碼幾乎逐行對得上 a5ce7ac 的 `src/web/`：要追某段邏輯的歷史，`git log a5ce7ac -- src/web/<對應路徑>.tsx` 即可。

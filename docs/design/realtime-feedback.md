# 設計規格 — feat/realtime-feedback（T9）

適用：`src/web/lib/**`、`src/web/ui/**`、`src/web/styles/**` 與各 feature 的動畫 / toast 接點。色彩、字級、間距、Toast 外觀、Dialog 一律引用 `core-shell.md`（下稱 core），不重定義；本文件只**新增**動態 token 並規定行為。

原則：自己的操作用最短的確認；他人的變更優先「就地標示」，只有影響到我手上工作時才打斷。動畫只說明「東西從哪來、往哪去」，一律 ≤ 320ms，只動 `transform` 與 `opacity`（列高收合例外），且都有 reduced-motion 的靜態等效呈現（§5）。

## 1. 新增動態 token（加在 `tokens.css`，沿用 core 既有三個）

| 變數 | 值 | 用途 |
|---|---|---|
| `--duration-fast`（core） | 120ms | hover、按下、拖起、列淡出 |
| `--duration-base`（core） | 200ms | toast / 抽屜 / Dialog 進場、列插入、讓位 |
| `--duration-exit` | 150ms | 任何離場（比進場快） |
| `--duration-slow` | 320ms | 他人造成的位置移動（跨欄、重新排序） |
| `--duration-highlight` | 1200ms | 「剛更新」底色淡出 |
| `--ease-standard`（core） | `cubic-bezier(.2,0,0,1)` | 位置移動、尺寸變化 |
| `--ease-enter` | `cubic-bezier(0,0,.2,1)` | 進場（減速） |
| `--ease-exit` | `cubic-bezier(.4,0,1,1)` | 離場（加速） |

## 2. Toast

外觀沿用 core 的 `Toast` 與 `.toast-viewport`（右下、寬 360、`--shadow-md`、`--z-toast`）；T9 補上佇列與行為。

| 類型 | 圖示色 | 停留 | `role` | 用途 |
|---|---|---|---|---|
| success | `--color-success` | 2.5 秒 | `status` | 自己的寫入成功 |
| info | `--color-info` | 5 秒 | `status` | 他人變更、連線恢復 |
| warning | `--color-warning` | 8 秒 | `alert` | 連線中斷、登入即將到期 |
| danger | `--color-danger` | 8 秒；帶動作鈕時不自動消失 | `alert` | 寫入失敗 |

- 佇列：最多同時顯示 3 則，新的在最下方，超過時最舊的先離場。滑鼠移入 viewport、鍵盤 focus 在任一則、或視窗失焦時**全部暫停計時**。
- 合併：同類成功訊息在前一則尚未消失時**更新原則內容並重新計時**（例：連續新增 → 「已建立 3 個任務」）。相同錯誤 2 秒內重複只顯示一則。
- 就地編輯成功**不發 toast**（欄位以 §3 的更新高亮確認）；成功 toast 只用於結果不在眼前的操作（建立、刪除、拖放、排程、複製）。失敗一律發 toast。
- 每則右側有關閉鈕（`aria-label="關閉通知"`）；動作鈕最多一個，用 ghost Button `sm`。768–1023px 時 viewport 距邊改 16px，單則寬 `min(360px, 100vw - 32px)`。
- viewport 為 `role="region"` `aria-label="通知"`；`Alt+T` 把 focus 移到最新一則，`Esc` 關閉 focus 中的那則並把 focus 還回原處。

### 文案

規則：標題不超過 14 個全形字、不加句號與驚嘆號、不寫「成功」；項目名稱用「」包住並截斷為 20 字；說明列只在需要補充原因或下一步時出現。

| 情境 | 類型 | 標題 | 說明／動作 |
|---|---|---|---|
| 建立任務（連續時合併） | success | 已建立任務／已建立 N 個任務 | 單筆時說明為任務標題，動作「開啟」→ `openTask(id)` |
| 刪除 | success | 已刪除「{標題}」 | — |
| 拖放改狀態 | success | 已移至「{狀態}」 | — |
| 日曆排程／標記／複製 | success | 已排入 {M/D}／已取消排程／已加入我的標記／已移出我的標記／已複製 | — |
| 寫入失敗（通用） | danger | 無法儲存變更 | 「已還原為先前的內容。」動作「重試」 |
| 離線或逾時 | danger | 連線中斷，變更未送出 | 「已還原為先前的內容。」動作「重試」 |
| 驗證錯誤 400 | danger | 內容格式不正確 | 後端訊息 |
| 無權限 403 | danger | 沒有權限執行此操作 | — |
| 項目已不存在 404 | danger | 此項目已被刪除 | 「清單已更新。」 |
| 他人更新我正在編輯的項目 | info | {姓名} 更新了「{標題}」 | 動作「查看」→ `openTask(id)` |
| 他人刪除我正在看的項目 | warning | {姓名} 刪除了「{標題}」 | — |

失敗時樂觀更新回復：畫面先以 §3 的位置移動動畫還原，再出現 toast；「重試」以相同參數重送，重試中動作鈕顯示 Spinner。

## 3. 動畫規格

| 對象 | 進場 / 變化 | 離場 |
|---|---|---|
| Toast | `translateY(8px)`→0 + 淡入，`--duration-base` `--ease-enter` | 淡出 + `translateX(16px)`，`--duration-exit` `--ease-exit`；其餘補位 `--duration-base` `--ease-standard` |
| 清單列新增 / 刪除 | 列高 0→`--row-height` + 淡入，`--duration-base` `--ease-enter`，接著播更新高亮 | 淡出 `--duration-fast`，再收合列高 `--duration-exit` `--ease-exit` |
| 清單重新排序 | 位置移動（FLIP）`--duration-base` `--ease-standard` | — |
| 更新高亮（列、卡片、欄位值） | 底色 `--color-accent-soft` → 透明，`--duration-highlight` 線性 | — |
| Kanban 拖起 → 放下 / 讓位 | 拖起 `scale(1.02)` + `--shadow-sm`，`--duration-fast`；落定與其他卡片讓位 `--duration-base` `--ease-standard` | 寫入失敗時以同參數滑回原位 |
| Kanban 他人移動的卡片 | 跨欄位置移動 `--duration-slow` `--ease-standard`，落定後播更新高亮 | — |
| 日曆 / Gantt 項目變動 | 位置與長度變化 `--duration-base` `--ease-standard` | 僅淡出 `--duration-fast`，不收合 |
| TaskDrawer | `translateX(24px)`→0 + 淡入，`--duration-base` `--ease-enter` | 反向，`--duration-exit` `--ease-exit` |
| Dialog 與遮罩 | `scale(.98)`→1 + 淡入；遮罩淡入，`--duration-base` `--ease-enter` | 淡出 `--duration-exit` |

- 不播動畫：頁面初次載入、切換篩選 / 分組 / 檢視、一次變動超過 20 個項目（直接替換內容）。拖曳進行中，被拖項目跟手無延遲；因他人變更而需移動的項目延到放下後才更新。動畫期間不阻擋操作；同一元素的新動畫從目前位置接續，不排隊。

## 4. 他人變更提示

資料來源為同步事件（誰、哪個項目、動作）；「改了哪些欄位」由前端比對重抓前後的資料得出，比對不出來時只說「更新了此項目」。自己造成的事件（含自己其他分頁）只靜默更新，不提示。

| 層級 | 條件 | 呈現 |
|---|---|---|
| A 就地標示 | 項目在畫面上，但我沒有開啟或編輯它 | 靜默更新內容 + 更新高亮；`<UpdatedAt>` 即時變為「剛剛」。**不發 toast** |
| B 情境提示條 | TaskDrawer（或問題回饋詳情）正開著該項目 | 內容直接更新、變動的欄位值播更新高亮；標題列下方滑出 info-soft 提示條（core §5 提示列樣式）：「(頭像) 李大華 剛更新了此任務 · 狀態、到期日」，6 秒後收起，可手動關閉 |
| C 編輯衝突 | 我正 focus 在某欄位且有未儲存的輸入，他人改了同一欄位 | **不覆蓋我的輸入**；欄位下方 `--text-xs` warning-text：「李大華 剛將此欄位改為「{新值}」」+ ghost 鈕「採用」。我照常儲存即以我的為準（後寫入者勝） |
| D toast | 我正在就地編輯清單中的某列（無抽屜可放提示條），或我開啟中的項目被刪除 | §2 文案表的 info / warning toast |

- 項目被他人刪除且抽屜開著：內容換為 EmptyState「此任務已被 李大華 刪除」+「關閉」；清單中的該列依 §3 離場。
- 合併：同一人 10 秒內對同一項目的多次變更只提示一次；多人時寫「李大華 等 2 人」。欄位名最多列 3 個，其餘寫「等 N 項」。姓名用顯示名稱，搭配 Avatar `xs`。

**連線狀態**（不改 shell，以一則常駐 toast 呈現於 viewport 最下方，不計入 3 則上限）：
- 正常、或中斷未滿 5 秒：不顯示任何東西（靜默重連）。中斷 5 秒以上：warning「即時更新中斷，正在重新連線…」，帶 Spinner，不可關閉。
- 已退回輪詢：同一則改為 info「目前每 30 秒更新一次」，可關閉；背景持續嘗試重連。
- 恢復：同一則改為 success「已恢復即時更新」，2.5 秒後消失並重抓目前頁面資料（重抓造成的變動不播增刪動畫）。

## 5. `prefers-reduced-motion: reduce`

- 媒體查詢內把本文件與 core 的所有 `--duration-*` 設為 0ms；以程式計算的位置移動（FLIP、拖放落定）另以 `matchMedia` 判斷後直接跳到終點。系統設定在使用中切換時即時生效。
- 位移、縮放、列高收合全部取消：toast、抽屜、Dialog 直接出現 / 消失；清單增刪直接插入 / 移除。
- 更新高亮改為靜態標示：項目左緣 2px `--color-accent` 直線停留 2 秒後直接移除（無漸變），資訊不因關閉動畫而遺失。
- Skeleton 脈動停止（維持靜態底色）；Spinner 保留旋轉（表示進行中，屬必要回饋）。toast 停留時間、提示條 6 秒、倒數計時不變。

## 6. 閒置登出前提醒

觸發：距離閒置逾時剩 5 分鐘時（預設第 55 分鐘），以 Dialog `sm` 呈現，`role="alertdialog"`。

```
 ┌──────────────────────────────────────┐
 │ 即將自動登出                         │
 │ 你已有一段時間沒有操作，將在         │
 │            4:59                      │  ← --text-2xl 600、tabular-nums
 │ 後自動登出。                         │
 │                 [立即登出] [繼續使用] │
 └──────────────────────────────────────┘
```

- 「繼續使用」primary 為預設 focus，`Enter` 即延續（一鍵）：送出 heartbeat → 成功即關閉 Dialog，不另發 toast。「立即登出」secondary。**Esc 與點遮罩不關閉**，無右上關閉鈕。
- 提醒顯示期間，背景的滑鼠 / 鍵盤事件不視為操作，只有按「繼續使用」才延續。倒數每秒更新；剩 60 秒起數字改用 `--color-danger-text`。螢幕閱讀器只在出現時、剩 1 分鐘、剩 30 秒各播報一次。
- 分頁在背景時把頁面標題改為「(4:59) 即將登出 — TasksSheets」，關閉提醒後還原。多分頁：任一分頁延續或登出，其他分頁的提醒同步關閉 / 一起登出。
- heartbeat 失敗：Dialog 內文上方顯示 danger-soft 提示列「無法延長登入，請檢查連線」，主要鈕文字改為「重試」；倒數持續。倒數歸零：關閉 Dialog、清除快取，導向 `/login?reason=expired&next=<原路徑>`（core §4.4）。
- 9 小時絕對到期（建議項，非驗收必要）：到期前 5 分鐘發 warning toast（不自動消失）「登入將於 5 分鐘後到期」，說明「已達單次登入上限，無法延長，請先完成手邊的編輯。」，動作「知道了」。與閒置提醒同時成立時只顯示這一則。

實作檢查：文案逐字採用 §2 文案表；動畫時長與曲線皆取自 token、無寫死毫秒數；失敗時先回復畫面再出 toast；編輯中的輸入不被他人變更覆蓋；SSE 與輪詢不會讓閒置提醒消失或延後。

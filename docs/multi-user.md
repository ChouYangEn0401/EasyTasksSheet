# 多人同時使用：架構、限制與驗證

本文說明 TasksSheets 在「實驗室多人同時使用」情境下的運作方式、已知限制與建議規模，以及在線感知（presence）的設計與隱私，最後附上併發測試結果。介面規格見 `docs/design/presence.md`。

## 1. 架構重點

| 項目 | 做法 |
|---|---|
| 行程 | **單一 uvicorn worker**（單一行程、單一事件迴圈）。SSE 廣播中心（`sync_hub.py`）與在線登錄（`presence.py`）都在記憶體中，**不可**開多個 worker 或多台機器分流，否則彼此看不到對方的事件與在線狀態。 |
| 資料庫 | SQLite，`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`。程式內只有一條連線，以 RLock 序列化存取；寫入一律 `BEGIN IMMEDIATE` transaction。 |
| 併發寫入 | 同一行程內所有寫入依序執行（每筆通常 < 1ms），不會出現 `database is locked`；外部行程（例如 `server.cli backup`）同時存取時由 WAL + busy_timeout 等待。 |
| 衝突處理 | 任務更新只寫有送來的欄位（**欄位層級合併**）：兩人改同一任務的不同欄位，兩者都保留；同一欄位則**後寫者勝**，changes 流水各記一筆，前端以「他人變更提示」告知（`realtime-feedback.md` §4）。 |
| 即時同步 | 每次寫入在同一 transaction 記錄 changes 流水；hub 每 250ms 查一次新流水並以 SSE `change` 事件推給所有連線（約 0.3 秒內到達）。SSE 中斷時前端退回 30 秒輪詢並自動重連補漏。 |

### `synchronous=NORMAL` 的取捨

WAL 模式下 `NORMAL` 不會造成資料庫損毀；最壞情況是作業系統斷電時遺失「最後一筆已 commit 的交易」。換來的是每次寫入不必 fsync，多人同時操作時延遲明顯較低。每日備份（`server.cli backup`）不受影響。

## 2. 閒置計時規則（登入逾時）

- 絕對期限 9 小時（`SESSION_MAX_HOURS`），閒置 60 分鐘（`SESSION_IDLE_MINUTES`）自動登出。
- **只有「非 GET 的寫入請求」刷新閒置計時**；GET（含 SSE、輪詢、`GET /api/presence`）一律不刷新。
- **例外：`PUT /api/presence` 不刷新**（`security.IDLE_EXEMPT_PATHS`）。在線回報只是「告訴別人我在哪」，不是實際操作；即使分頁一直開著、滑鼠一直在動、presence 每 20 秒回報，60 分鐘沒有實際寫入或點擊 / 鍵盤（前端 heartbeat）仍會被登出。前端也不把 presence 回報當作寫入（`web/static/js/lib/auth.js`）。
- 測試：`server/tests/test_presence.py::test_presence_does_not_refresh_idle`、`::test_presence_keepalive_cannot_keep_session_alive`；E2E presence「presence 不延長閒置登出（page.clock）」（1.x 為 `tests/e2e/presence.spec.ts`，2.0 起移植為 `tests/e2e/` 底下的 Python 版 Playwright）。

## 3. 在線感知（presence）

### 資料流

```
瀏覽器 ──PUT /api/presence {view, entity?, state, hidden}──▶ 記憶體登錄（user_id → 最後回報、頁面、任務）
        ◀──SSE `presence`（只在狀態 / 頁面 / 任務改變時）─── 逾時掃描（有 SSE 連線時每秒一次）
        ◀──GET /api/presence（SSE 中斷時每 15 秒）
                                   └─ user_presence 表（0009）：最後上線時間、最後看的頁面
```

- **狀態**：45 秒內有回報 = 在線；5 分鐘內（或分頁在背景）= 閒置；超過 = 離線。門檻：`PRESENCE_ONLINE_SECONDS`、`PRESENCE_IDLE_SECONDS`（測試可縮短，E2E 用 10 / 25 秒）。
- **只在變化時廣播**：keepalive 只更新時間，不推送；逾時轉閒置 / 離線由伺服器掃描後推送一次。
- **重啟**：即時狀態存在記憶體，伺服器重啟後全部視為離線；「最後上線 / 最後看的頁面」由 `user_presence` 表補上（keepalive 最多每 60 秒寫一次，頁面改變或離線時立即寫）。
- **前端回報**：換頁、開關任務抽屜、開始 / 結束就地編輯時立即送；有操作時每 20 秒 keepalive；分頁隱藏送一次 idle；關閉分頁送 away（`fetch keepalive`，失敗就等逾時）。沒有操作就不送任何請求。
- **多分頁**：同一人開多個分頁時以最後一次回報為準；關閉其中一個分頁會短暫顯示離線，直到另一個分頁下一次操作。

### 隱私

- 回傳欄位只有：成員 id、狀態、目前頁面名稱、正在看 / 編輯的任務（id、標題摘要 60 字、看或編輯）、最後上線時間、最後看的頁面名稱。任務標題本來就是全員可見資料；標題由伺服器查詢，已刪除的任務不會出現。
- **不顯示精確時間**（只有「剛剛 / 3 分鐘前 / 3 小時前」），不統計使用時長、不排名（面板組內依名稱排序）。
- **隱藏我的動態**：在線面板底部的開關（存在該瀏覽器的 `localStorage`，鍵 `presence.hideActivity`）。開啟後送出的回報帶 `hidden: true`，**伺服器端**一律把頁面與任務置空、「最後看的頁面」也不記錄，別人只看得到「在線上 / 暫時離開」。（帳號層級的設定可日後併入「個人設定」。）
- 停用的帳號不會出現在在線清單。

## 4. 建議規模與限制

- **建議**：同時在線 ≤ 30 人、同時開啟的分頁（SSE 連線）≤ 60 條、尖峰寫入 ≤ 數十次 / 秒。實驗室規模（10–20 人）有充足餘裕。
- 單一 worker：CPU 密集的請求（大量匯入、完整備份下載）執行期間其他請求會稍慢；匯入建議在離峰時進行。
- 反向代理必須關閉 SSE 緩衝（README 的 Caddy 設定已處理），否則即時更新與在線狀態會延遲。
- SQLite 檔必須放在本機磁碟，**不可**放在網路磁碟（NFS / SMB），WAL 需要共用記憶體檔。
- 不支援多台伺服器或多 worker；若未來超過上述規模，需改為外部訊息匯流排（例如 Redis）與伺服器型資料庫。

## 5. 併發測試結果（2026-11-25，Windows 11，Python 3.11）

測試檔：`server/tests/test_concurrency.py`（`python -m pytest server` 一併執行；隨機種子 `CONCURRENCY_SEED`，預設 20261125，可重現每位使用者的操作序列——實際交錯順序由執行緒排程決定，所以 404 次數等細節每次略有不同，驗證條件不受影響）。以 uvicorn 實際提供 app、檔案型 SQLite（WAL），每位使用者一個 httpx 連線、各自一條執行緒。

| 測試 | 內容 | 結果 |
|---|---|---|
| 8 人混合操作 | 8 人同時（Barrier 同步起跑）各 30 次、共 240 次：建立 / 更新 / 軟刪除任務（共用任務池）、個人待辦新增 / 勾選、建立回饋、presence 回報、讀總覽、讀 changes | 3 個種子（20261125 / 1 / 42）皆通過：0 個 5xx、0 次 `database is locked`；240 次約 0.3 秒完成；404 只來自「任務已被別人刪除」（12–20 次）；changes 流水序號連續無遺漏，筆數 = 成功寫入數（156–176 筆）；已刪除任務與 delete 流水一一對應 |
| 同任務同時 PATCH | 兩人以 Barrier 同時 PATCH：不同欄位 × 10 輪 | 兩欄位皆保留（10/10） |
| | 同一欄位 | 後寫者勝（最終值 = changes 中最後一筆的作者所寫），changes 兩筆 |
| SSE 30 連線 | 6 人 × 5 分頁共 30 條 SSE，背景每 20ms 持續寫入，同時建立 5 筆任務 | 30 條連線全部收到每一筆，最慢 47–63 ms（門檻 2 秒）；關閉後 hub 與 presence 訂閱數歸零、輪詢 / 掃描工作停止 |
| DB 設定 | `PRAGMA journal_mode / synchronous / busy_timeout` | wal / NORMAL(1) / 5000 |

E2E presence（1.x 為 `tests/e2e/presence.spec.ts`，2.0 起移植為 `tests/e2e/` 底下的 Python 版 Playwright）：三個瀏覽器 context（管理員、一般成員、晴恩）同時登入——A 在甘特圖、B 開任務抽屜、C 在清單就地改標題：A 的頭像卡片顯示 B「正在專心看」、C「正在編輯」，B 的抽屜顯示「晴恩 正在編輯」，C 送出後 B 的抽屜即時更新標題；C 關閉後 A 的面板在 60 秒內顯示晴恩離線與「最後看的是 清單」；隱藏動態後別人只看到「在線上」；以 `page.clock` 快轉 65 分鐘、期間持續有 presence 回報，仍準時閒置登出。

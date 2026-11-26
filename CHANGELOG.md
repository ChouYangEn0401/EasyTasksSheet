# 更新紀錄（CHANGELOG）

> 每一版一段：版本、日期、**資料格式有沒有變**、升級前要不要先備份。版本號在 `server/app/version.py`。
> 升級流程：先備份（`python -m server.cli backup`）→ 更新程式 → 重啟；資料庫 migration 會在啟動時自動套用，舊資料直接沿用。

## 2.0.0 — 2026-11-26

**整個系統只剩 Python。** 裝機 `python scripts/install.py`、啟動 `python main.py`；前端改成瀏覽器直接載入的原生 JS（`web/`），不再需要 Node.js、npm 或任何建置步驟。

- 資料格式：**沒有變**。`data/app.db` 原檔沿用，不需要搬資料；migration 編號接續 0020。
- 升級前：照慣例先 `python -m server.cli backup`（非必要）。
- 設定：`NODE_ENV` 改名 `APP_ENV`（舊名仍可用）；`WEB_PORT`、`STATIC_DIR` 不再使用（留在 .env 不會壞，啟動時會提示）。
- 部署：Windows 安裝／更新腳本不再下載 Node；Docker 映像少掉 node 階段；`dist/`、`node_modules/`、`.tools/` 是舊版殘留，可手動刪除。
- 介面：右下角顯示版本與作者；`/api/health` 回 `version`。
- 工程追蹤的回報腳本：`node scripts/report-worktrees.mjs` → `python scripts/report_worktrees.py`（參數與輸出相同）。
- 功能：全部保留（清單／看板／甘特／延遲鏈／回饋月曆／總覽／個人清單與匯報／工程追蹤／成員／權限／稽核／資料管理／同步／搬家包／設定／即時同步／復原／在線感知）。
- 新功能：
  - **Ctrl+K 全站搜尋**：任務／專案／成員／頁面、`#編號`、最近開啟、快速前往。
  - **阻擋鍊看得懂**：任務抽屜「相依」改成上游→本任務→下游的時間線，標出「目前等待」、逾期天數、預計延後；清單與看板有「被擋 N／擋著 N」標記；延遲鏈頁有摘要列與 `?focus=` 聚焦。
  - **個人頁「本週」卡**：進行中／本週到期／本週完成一眼看到。
  - **匯報模版**：工作日誌（實驗室現行格式 `[專案] - 人名`）、個人週報、PL 匯報、設計決議；一鍵複製（含 HTML 格式）、下載 .md／.html、「今日」範圍給每日 PPT。
  - 討論區：日期分隔、同作者連續訊息折疊、提到我的標示。
  - 設定頁：「整合（規劃中）」預留區（AI 之後接）與「關於」卡。
- 介面微調：對比達 WCAG AA、側欄分組與選中態、清單到期色（逾期紅／今天橘）與狀態點、看板卡進度條。
- 測試：前端的 vitest 與 TypeScript E2E 移除；E2E 改成 Python 版 Playwright（`tests/e2e/`）；後端 pytest 不變。

## 1.x — 2026-11-25 以前

React + Vite 前端、Python 後端的時期。細節見 `PROGRESS.md`（歷史紀錄）。

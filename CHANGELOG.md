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
- 測試：前端的 vitest 與 TypeScript E2E 移除；E2E 改成 Python 版 Playwright（`tests/e2e/`）；後端 pytest 不變。

## 1.x — 2026-11-25 以前

React + Vite 前端、Python 後端的時期。細節見 `PROGRESS.md`（歷史紀錄）。

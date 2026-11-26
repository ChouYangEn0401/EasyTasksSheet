# 待套用到「152 Server 交接書」的修改：加入 EasyTasksSheet

- 對象：`152-handoff.html`（https://claude.ai/artifact/EYxAdfmi7Dd3C7Y35hcxEa），基準 version `1795592360-c2a6`、rev `2026-11-25.2`
- 狀態：**尚未發佈**。照 artifact-sync-protocol v2 §3–§6 套用：讀線上版（要讀完全文）→ 比對 `152-handoff.sync.json` → 上鎖 → 改 → 發佈並解鎖 → 存回本機。
- 全部屬於 <span>建議目標／待辦</span>：EasyTasksSheet 還沒在 152 上安裝，所以一律標 `待辦`，不要寫進「目前狀態」。
- 依據：本 repo 的 `docs/DEPLOY-152.md`、`deploy/windows/`。

## 1. 三十秒摘要（`ul.facts`）

「後端」一條改成：Gitea（3000）、pyDMS（8000）與 EasyTasksSheet（8100，待辦）只綁 `127.0.0.1`。

## 2. 架構圖第 3、4 層

- 第 3 層 nginx 的分流加上 `/easytasks/` → 8100。
- `split` 加第三格 `4c EasyTasksSheet`：`127.0.0.1:8100`，NSSM 服務 `easytasks`；靠 `BASE_PATH=/easytasks` 知道自己的前綴（伺服器每次回首頁時代入、cookie Path；改了只要重啟）。<span class="st st-todo">待辦</span>

## 3. 對外網址表（`#ov-urls`）加一列

| `https://140.112.180.152/easytasks/` | EasyTasksSheet（任務／專案管理） | 待辦。首次登入 admin / password，強制改帳密 |

## 4. 埠與服務（`#ov-ports`）加一列

| 8100 | EasyTasksSheet | 127.0.0.1 | 沒有規則（也不需要） | 維持沒有規則；只走 nginx 443 | 待辦 |

## 5. 檔案與路徑（`#ov-paths`）加列

| EasyTasksSheet 程式 | `C:\EasyTasksSheet\` | git 工作副本；venv 在 `.venv\`；進入點 `main.py`；前端是 `web\` 底下的靜態檔（2.0 起不需建置、不需 Node.js） |
| EasyTasksSheet 設定 | `C:\EasyTasksSheet\.env` | 範本 `deploy\windows\env.152.example`；不進 git |
| EasyTasksSheet 資料 | `C:\EasyTasksSheet\data\app.db`、`data\attachments\` | SQLite；排程每天備份到 `.env` 的 `BACKUP_DIR` |
| EasyTasksSheet log | `C:\EasyTasksSheet\logs\easytasks.out.log`、`easytasks.err.log`、`backup.log` | NSSM 10 MB 輪替 |
| EasyTasksSheet 腳本 | `C:\EasyTasksSheet\deploy\windows\` | setup／install／uninstall／update／backup 五支 .bat |

## 6. C:\scripts 腳本表（`#ov-scripts`）

`services_restarter.bat`、`services_terminator.bat` 的「已知問題」欄加：「沒有包含 easytasks <span class="st st-todo">待辦</span>：加 `net stop easytasks`／`net start easytasks`」。

## 7. 6.2 nginx.conf 建議目標（`#nginx-next`）

在兩個 location 後面加上 `deploy/windows/nginx-easytasks.conf` 的內容（`location = /easytasks` 補斜線、`location /easytasks/` 去前綴轉 8100、`proxy_buffering off` 給 SSE、XFF 覆寫）。

## 8. 6.5 服務與 NSSM 參數（`#cf-svc`）加一列

| easytasks | NSSM（`install_easytasks_service.bat`） | `.venv\Scripts\python.exe main.py`，工作目錄 `C:\EasyTasksSheet` | 待補（預設 LocalSystem） | 自動 | NSSM 自動重啟，延遲 5 秒（腳本明確設定 AppExit Default Restart） |

## 9. 8 日常維護

- 健康檢查（`#m-check`）加：`(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8100/api/health).StatusCode` → 200。
- 新小節「更新 EasyTasksSheet」：`C:\EasyTasksSheet\deploy\windows\update_easytasks.bat`（先備份 → `git pull --ff-only` → 套件 → 重啟 → 健康檢查；任何一步失敗就停、不重啟）。
- 備份（`#m-backup`）：EasyTasksSheet 不靠 backup.bat，由工作排程器 `EasyTasksSheet Backup`（每天 03:17，SYSTEM）執行 `backup_easytasks.bat`；線上備份不用停服務。

## 10. 待辦總表（`#todo`）新增一組「2026-11-25 新增：EasyTasksSheet」

1. （已不需要：2.0 起不需 Node.js，原本「152 安裝 Node.js 22 LTS 或在開發電腦建置 `dist\web`」這項刪除。）
2. clone 到 `C:\EasyTasksSheet` → `setup_easytasks.bat` → `install_easytasks_service.bat check` → 正式跑。
3. nginx 加 `location /easytasks/`，`-t` 後 reload。
4. `jump_page.html` 換成 `deploy/windows/jump_page.html`（多一張 EasyTasksSheet 卡片）。
5. 註冊備份排程並跑一次；`backup --self-test` 演練還原。
6. `services_restarter.bat`、`services_terminator.bat` 加 easytasks。
7. 倉庫要不要搬到 152 的 Gitea（目前在 GitHub）。<span class="st st-decide">待決定</span>

## 11. 驗證指令（`#verify`）加

- 機械系電腦：`curl.exe -k -s -o NUL -w "%{http_code}" https://140.112.180.152/easytasks/api/health` → `200`
- 校外手機：開 `https://140.112.180.152/easytasks/` → 與 `/pydms/` 相同（目前 403，防火牆收尾後逾時）
- 152：`netstat -ano | findstr :8100` 只看到 `127.0.0.1:8100`

## 12. 頁首

`meta` 的「最後整理」改成第 9 版；「怎麼讀這份文件」加一段第 9 版說明：新增 EasyTasksSheet（`/easytasks/`、8100、NSSM `easytasks`），全部是待辦。

# C:\scripts 用的腳本（152 server）

把這個資料夾的 `.bat` 全部複製到 152 的 `C:\scripts\`（覆蓋同名檔）。都要用「系統管理員」cmd 執行。

| 檔案 | 狀態 | 做什麼 |
| ---- | ---- | ---- |
| `easytasks_setup.bat` | 新增 | 第一次（或更新後）準備環境：clone／pull → `.venv` → pip → `.env` → 建置前端 |
| `easytasks_installer.bat` | 新增 | 只建立／重建 NSSM 服務 `easytasks`（同 `pythondms_installer.bat` 的做法） |
| `install_services.bat` | 修改 | 加第 4 段 EasyTasksSheet；修正 `PYTHON_EXE` 被斷成兩行的錯；port 檢查改成 80、443、3000、8000、8100 |
| `services_restarter.bat` | 修改 | 加 easytasks |
| `services_terminator.bat` | 修改 | 加 easytasks |
| `backup.bat` | 修改 | 加 EasyTasksSheet（資料庫線上備份＋`.env`）；修正最後啟動的服務名 `fastapi` → `python-dms` |

`pythondms_installer.bat` 不用改。

第一次安裝順序：`easytasks_setup.bat` → `easytasks_installer.bat` → `C:\EasyTasksSheet\deploy\windows\apply_nginx.bat check` → 正式跑。

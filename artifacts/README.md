# Artifact 本機鏡像

依 artifact-sync-protocol v2：線上 artifact 是正本，這裡放逐字相同的 HTML 與 `<slug>.sync.json`（最後一次一致時的 version、rev、sha256）。
**不要直接改這裡的 HTML 再當成正本**：先讀線上版、比對 `.sync.json`、上鎖，改完發佈後再存回來。

| 檔案 | 線上 |
| ---- | ---- |
| `152-handoff.html` | 152 Server 交接書 https://claude.ai/artifact/EYxAdfmi7Dd3C7Y35hcxEa |
| `152-rebuild-guide.html` | 152 重架導覽 https://claude.ai/artifact/RGnu9AQYTZXveJYmcxqWzM（由 installer 專案的 `guide_build/build.py` 產生：要改請改那邊的 `steps.py`，不要改這份） |
| `152-handoff.PENDING-easytasks.md` | 尚未套用到交接書的修改（加入 EasyTasksSheet） |

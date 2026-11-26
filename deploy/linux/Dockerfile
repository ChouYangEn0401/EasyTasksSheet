# 可選：以容器部署。從專案根目錄建置：
#   docker build -f deploy/linux/Dockerfile -t tasks-sheets .
# 或使用 deploy/linux/docker-compose.yml。
# 排除清單見 deploy/linux/Dockerfile.dockerignore（BuildKit 會自動套用與 Dockerfile 同名的 .dockerignore）。

# ── 執行環境（Python + uvicorn；前端是 web/ 底下的靜態檔，沒有建置步驟）──
FROM python:3.11-slim
ENV APP_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/app.db \
    ATTACHMENTS_DIR=/data/attachments \
    BACKUP_DIR=/backups \
    TZ=Asia/Taipei \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin app
WORKDIR /app
# 只安裝執行所需套件（略過 requirements.txt 中的測試套件）
COPY server/requirements.txt ./server/requirements.txt
RUN grep -vE '^(pytest|httpx)' server/requirements.txt > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt
COPY server ./server
COPY web ./web
COPY main.py ./main.py
RUN mkdir -p /data /backups && chown app:app /data /backups
USER app
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=4).status == 200 else 1)"
# 單一 worker（SSE 事件中樞與 SQLite 連線在同一個行程內）；HOST / PORT 取自環境變數
CMD ["python", "-m", "server.app"]

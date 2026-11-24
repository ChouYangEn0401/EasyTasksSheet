# 可選：以容器部署。從專案根目錄建置：
#   docker build -f deploy/Dockerfile -t tasks-sheets .
# 或使用 deploy/docker-compose.yml。

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/app.db \
    BACKUP_DIR=/backups \
    STATIC_DIR=dist/web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/web ./dist/web
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
RUN mkdir -p /data /backups && chown node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server/index.ts"]

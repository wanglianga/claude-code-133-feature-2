# 云顶山观光车平台 · 后端（NestJS + better-sqlite3）
FROM node:22-bookworm-slim AS builder

# better-sqlite3 在无预编译包时需要本地编译工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# 裁掉开发依赖（保留已编译好的 better-sqlite3 原生模块）
RUN npm prune --omit=dev

# ---- 运行镜像 ----
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3001

# 首次启动自动建表并写入演示种子数据
CMD ["node", "dist/main.js"]

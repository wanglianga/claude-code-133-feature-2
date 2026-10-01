# syntax=docker/dockerfile:1
# 景区观光车平台 —— 一键构建镜像
# 多阶段：构建前端 + 编译后端 → 仅含运行时依赖的精简镜像
# 容器内由 NestJS 同源托管前端静态文件，单端口（3001）即可使用全部功能

FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 为原生模块，安装时需要编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先拷贝各子工程清单，尽量利用构建缓存
COPY server/package.json server/package-lock.json ./server/
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix server
RUN npm ci --prefix web

# 构建
COPY . .
RUN npm run build --prefix web
RUN npm run build --prefix server

# ---------- 运行镜像 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SQLITE_PATH=/app/server/data/app.sqlite
ENV WEB_DIST=/app/web/dist

COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist ./web/dist

RUN mkdir -p /app/server/data
VOLUME ["/app/server/data"]
EXPOSE 3001

CMD ["node", "server/dist/main.js"]

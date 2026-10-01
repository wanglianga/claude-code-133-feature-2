# 云顶山观光车平台 · 前端（React + Vite 构建，nginx 托管）
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache

COPY tsconfig.json index.html vite.config.ts ./
COPY src ./src
RUN npm run build

# ---- 运行镜像 ----
FROM nginx:1.27-bookworm AS runtime
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

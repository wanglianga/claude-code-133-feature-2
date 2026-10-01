import 'reflect-metadata';
import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));

  // 生产模式：由后端同源托管前端构建产物（Docker 一键启动）；
  // 本地开发仍用 Vite（5173）通过代理访问 /api。
  const webDist = process.env.WEB_DIST
    ? process.env.WEB_DIST
    : join(__dirname, '../../web/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        return res.sendFile(join(webDist, 'index.html'));
      }
      next();
    });
  }

  const port = Number(process.env.PORT || 3001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`[scenic-shuttle] API listening on http://localhost:${port}/api`);
  if (existsSync(join(webDist, 'index.html'))) {
    // eslint-disable-next-line no-console
    console.log(`[scenic-shuttle] Web console: http://localhost:${port}`);
  }
}
bootstrap();

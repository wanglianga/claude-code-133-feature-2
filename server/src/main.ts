import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  // 首次运行时确保 SQLite 数据目录存在
  if ((process.env.DB_TYPE || 'sqlite').toLowerCase() !== 'mysql') {
    const sqlitePath = process.env.SQLITE_PATH || `${__dirname}/../data/app.sqlite`;
    mkdirSync(dirname(sqlitePath), { recursive: true });
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  const port = Number(process.env.PORT || 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`[scenic-shuttle] API listening on http://localhost:${port}/api`);
}
bootstrap();

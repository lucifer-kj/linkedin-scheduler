import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config/app-config.service.js';
import { PinoLoggerService } from './common/logger/pino-logger.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(PinoLoggerService);
  const config = app.get(AppConfigService);

  app.useLogger(logger);
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  if (!config.isProduction) {
    app.enableCors({
      origin: true,
      credentials: true,
    });
  }

  await app.listen(config.port);
  logger.log(`NestJS server listening on http://localhost:${config.port}/api`, 'Bootstrap');
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap NestJS application:', error);
  process.exit(1);
});

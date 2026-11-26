import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppConfigService } from '../config/app-config.service.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: PinoLoggerService
  ) {
    super({
      datasources: {
        db: {
          url: config.databaseUrl,
        },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (this.config.isTest) {
      return;
    }

    try {
      await this.$connect();
      this.logger.log('Connected to PostgreSQL via Prisma', 'PrismaService');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Initial PostgreSQL connection deferred (will connect lazily on query): ${detail}`,
        'PrismaService'
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch {
      // Ignore disconnect errors during shutdown when never connected
    }
  }
}

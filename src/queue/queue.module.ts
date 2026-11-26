import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { PinoLoggerService } from '../common/logger/pino-logger.service.js';
import { BULLMQ_REDIS_CONNECTION, LINKEDIN_POSTS_QUEUE } from './queue.constants.js';
import { createBullRedisClient } from './redis-connection.js';

@Module({
  providers: [
    {
      provide: BULLMQ_REDIS_CONNECTION,
      inject: [AppConfigService, PinoLoggerService],
      useFactory: (config: AppConfigService, logger: PinoLoggerService): Redis =>
        createBullRedisClient(config.redisUrl, {
          isTest: config.isTest,
          logger,
        }),
    },
  ],
  exports: [BULLMQ_REDIS_CONNECTION],
})
class RedisConnectionModule implements OnApplicationShutdown {
  constructor(
    @Inject(BULLMQ_REDIS_CONNECTION)
    private readonly redisConnection: Redis
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.redisConnection) {
      return;
    }
    try {
      if (typeof this.redisConnection.quit === 'function') {
        await this.redisConnection.quit();
      }
    } catch {
      if (typeof this.redisConnection.disconnect === 'function') {
        this.redisConnection.disconnect();
      }
    }
  }
}

@Module({
  imports: [
    RedisConnectionModule,
    BullModule.forRootAsync({
      imports: [RedisConnectionModule],
      inject: [BULLMQ_REDIS_CONNECTION],
      useFactory: (connection: Redis) => ({
        connection,
      }),
    }),
    BullModule.registerQueue({
      name: LINKEDIN_POSTS_QUEUE,
    }),
  ],
  exports: [BullModule, RedisConnectionModule],
})
export class QueueModule {}

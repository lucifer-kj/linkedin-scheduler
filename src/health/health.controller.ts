import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { MockLinkedInClient } from '../linkedin/mock-client.js';
import { BULLMQ_REDIS_CONNECTION } from '../queue/queue.constants.js';
import { PostsService } from '../posts/posts.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly postsService: PostsService,
    @Inject(BULLMQ_REDIS_CONNECTION)
    private readonly redis: Redis
  ) {}

  @Get()
  async getHealth() {
    let dbOk = false;
    let redisOk = false;
    let recoveredPosts = 0;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    try {
      const pong = await this.redis.ping();
      redisOk = pong === 'PONG';
    } catch {
      redisOk = false;
    }

    if (dbOk && redisOk) {
      try {
        recoveredPosts = await this.postsService.recoverOverduePosts();
      } catch {
        recoveredPosts = 0;
      }
    }

    const payload = {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
      recoveredPosts,
      mode: this.config.useMockLinkedin ? 'mock' : 'live',
      simulateTransientFailure: MockLinkedInClient.simulateTransientFailure,
      timestamp: new Date().toISOString(),
    };

    if (!dbOk || !redisOk) {
      throw new ServiceUnavailableException(payload);
    }

    return payload;
  }
}

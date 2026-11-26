import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getQueueToken, BullRegistrar } from '@nestjs/bullmq';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { TENANT_COOKIE_NAME } from '../../src/common/tenant/tenant-session.middleware.js';
import {
  BULLMQ_REDIS_CONNECTION,
  LINKEDIN_POSTS_QUEUE,
} from '../../src/queue/queue.constants.js';

describe('AppModule NestJS DI & Express 5 HTTP Smoke', () => {
  let app: INestApplication;
  const usersBySession = new Map<string, { id: string; sessionId: string }>();
  let seq = 1;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@localhost:5432/linkedin_scheduler?schema=public';
    process.env.ENCRYPTION_MASTER_KEY =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    process.env.SESSION_SECRET = 'test-session-secret-32-chars-minimum';

    const mockPrisma = {
      user: {
        findUnique: async ({ where }: { where: { sessionId: string } }) =>
          usersBySession.get(where.sessionId) ?? null,
        create: async ({ data }: { data: { sessionId: string } }) => {
          const user = { id: `di-user-${seq++}`, sessionId: data.sessionId };
          usersBySession.set(data.sessionId, user);
          return user;
        },
      },
      post: {
        findMany: async () => [],
      },
      $queryRaw: async () => [{ '?column?': 1 }],
      $connect: async () => {},
      $disconnect: async () => {},
    };

    const mockRedis = {
      ping: async () => 'PONG',
      quit: async () => 'OK',
      disconnect: () => {},
      on: () => {},
      status: 'ready',
    };

    const mockQueue = {
      add: async () => ({ id: 'mock-job' }),
      getJob: async () => null,
      remove: async () => 1,
      close: async () => {},
    };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(BULLMQ_REDIS_CONNECTION)
      .useValue(mockRedis)
      .overrideProvider(getQueueToken(LINKEDIN_POSTS_QUEUE))
      .useValue(mockQueue)
      .overrideProvider(BullRegistrar)
      .useValue({ onModuleInit: () => {} })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('serves GET /api/health with DI wired and issues li_scheduler_sid cookie once per session', async () => {
    const res1 = await request(app.getHttpServer()).get('/api/health').expect(200);

    expect(res1.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
    expect(typeof res1.body.timestamp).toBe('string');

    const setCookieHeader = res1.headers['set-cookie'];
    expect(Array.isArray(setCookieHeader)).toBe(true);
    const sidCookie = (setCookieHeader as string[]).find((c) => c.startsWith(`${TENANT_COOKIE_NAME}=`));
    expect(sidCookie).toBeDefined();
    expect(sidCookie).toContain('HttpOnly');
    expect(sidCookie).toContain('SameSite=Lax');

    const cookiePair = sidCookie!.split(';')[0];
    const res2 = await request(app.getHttpServer())
      .get('/api/health')
      .set('Cookie', cookiePair)
      .expect(200);

    expect(res2.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
    expect(res2.headers['set-cookie']).toBeUndefined();
    expect(usersBySession.size).toBe(1);

    // Non-/api routes must not trigger TenantSessionMiddleware
    const nonApiRes = await request(app.getHttpServer()).get('/not-an-api-route').expect(404);
    expect(nonApiRes.headers['set-cookie']).toBeUndefined();
    expect(usersBySession.size).toBe(1);
  });
});

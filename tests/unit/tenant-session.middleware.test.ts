import { describe, it, expect, vi } from 'vitest';
import {
  TenantSessionMiddleware,
  TENANT_COOKIE_NAME,
  type TenantCookieOptions,
  type TenantRequest,
  type TenantResponse,
} from '../../src/common/tenant/tenant-session.middleware.js';
import { parseEnv } from '../../src/config/env.schema.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';

function createConfig(nodeEnv: 'development' | 'production' | 'test' = 'test') {
  return AppConfigService.fromEnv(
    parseEnv({
      NODE_ENV: nodeEnv,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/linkedin_scheduler?schema=public',
      ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SESSION_SECRET: 'test-session-secret-32-chars-minimum',
    })
  );
}

function createInMemoryPrismaMock() {
  const usersBySession = new Map<string, { id: string; sessionId: string }>();
  let seq = 1;

  const findUnique = vi.fn(async ({ where }: { where: { sessionId: string } }) => {
    return usersBySession.get(where.sessionId) ?? null;
  });

  const create = vi.fn(async ({ data }: { data: { sessionId: string } }) => {
    const user = { id: `user-${seq++}`, sessionId: data.sessionId };
    usersBySession.set(data.sessionId, user);
    return user;
  });

  return {
    prisma: { user: { findUnique, create } } as unknown as PrismaService,
    findUnique,
    create,
  };
}

describe('TenantSessionMiddleware', () => {
  it('auto-provisions a new User and sets HMAC-signed httpOnly cookie when missing', async () => {
    const { prisma, create } = createInMemoryPrismaMock();
    const middleware = new TenantSessionMiddleware(prisma, createConfig('production'));

    const req: TenantRequest = { headers: {} };
    const cookiesSet: Array<{ name: string; value: string; options: TenantCookieOptions }> = [];
    const res: TenantResponse = {
      cookie: (name, value, options) => {
        cookiesSet.push({ name, value, options });
      },
    };
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(create).toHaveBeenCalledTimes(1);
    expect(req.tenant).toBeDefined();
    expect(req.tenant?.userId).toBe('user-1');

    expect(cookiesSet).toHaveLength(1);
    expect(cookiesSet[0].name).toBe(TENANT_COOKIE_NAME);
    expect(cookiesSet[0].options).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
    expect(middleware.verifySignedSessionId(cookiesSet[0].value)).toBe(req.tenant?.sessionId);
  });

  it('preserves existing valid tenant across requests without creating a new User', async () => {
    const { prisma, create, findUnique } = createInMemoryPrismaMock();
    const middleware = new TenantSessionMiddleware(prisma, createConfig('test'));

    const req1: TenantRequest = { headers: {} };
    let issuedCookie = '';
    const res1: TenantResponse = {
      cookie: (_name, value) => {
        issuedCookie = value;
      },
    };
    await middleware.use(req1, res1, vi.fn());

    const req2: TenantRequest = {
      headers: { cookie: `${TENANT_COOKIE_NAME}=${encodeURIComponent(issuedCookie)}` },
    };
    const res2CookieSpy = vi.fn();
    const res2: TenantResponse = { cookie: res2CookieSpy };
    const next2 = vi.fn();

    await middleware.use(req2, res2, next2);

    expect(next2).toHaveBeenCalledWith();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(res2CookieSpy).not.toHaveBeenCalled();
    expect(req2.tenant).toEqual(req1.tenant);
  });

  it('rejects tampered cookie signature and issues a fresh isolated tenant', async () => {
    const { prisma, create } = createInMemoryPrismaMock();
    const middleware = new TenantSessionMiddleware(prisma, createConfig('test'));

    const req1: TenantRequest = { headers: {} };
    let issuedCookie = '';
    await middleware.use(
      req1,
      {
        cookie: (_n, val) => {
          issuedCookie = val;
        },
      },
      vi.fn()
    );

    const tampered = issuedCookie.slice(0, -2) + (issuedCookie.endsWith('aa') ? 'bb' : 'aa');
    const reqTampered: TenantRequest = {
      cookies: { [TENANT_COOKIE_NAME]: tampered },
    };
    let rotatedCookie = '';
    await middleware.use(
      reqTampered,
      {
        cookie: (_n, val) => {
          rotatedCookie = val;
        },
      },
      vi.fn()
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(reqTampered.tenant?.userId).toBe('user-2');
    expect(reqTampered.tenant?.userId).not.toBe(req1.tenant?.userId);
    expect(rotatedCookie).not.toBe(issuedCookie);
  });

  it('isolates Tenant A and Tenant B concurrently', async () => {
    const { prisma } = createInMemoryPrismaMock();
    const middleware = new TenantSessionMiddleware(prisma, createConfig('test'));

    const reqA: TenantRequest = { headers: {} };
    const reqB: TenantRequest = { headers: {} };
    let cookieA = '';
    let cookieB = '';

    await middleware.use(reqA, { cookie: (_n, v) => (cookieA = v) }, vi.fn());
    await middleware.use(reqB, { cookie: (_n, v) => (cookieB = v) }, vi.fn());

    expect(reqA.tenant?.userId).not.toBe(reqB.tenant?.userId);
    expect(reqA.tenant?.sessionId).not.toBe(reqB.tenant?.sessionId);
    expect(cookieA).not.toBe(cookieB);
  });
});

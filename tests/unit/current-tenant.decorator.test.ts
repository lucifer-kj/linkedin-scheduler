import { describe, it, expect } from 'vitest';
import {
  Controller,
  Get,
  InternalServerErrorException,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CurrentTenant } from '../../src/common/tenant/current-tenant.decorator.js';
import type { TenantContext, TenantRequest } from '../../src/common/tenant/tenant-session.middleware.js';

type ParamDecoratorFactory = (
  data: keyof TenantContext | undefined,
  ctx: ExecutionContext
) => TenantContext | string;

function getParamDecoratorFactory(
  target: object,
  methodName: string
): ParamDecoratorFactory {
  const args = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    target.constructor,
    methodName
  ) as Record<string, { factory: ParamDecoratorFactory }>;
  const firstKey = Object.keys(args)[0];
  return args[firstKey].factory;
}

function createHttpExecutionContext(tenant?: TenantContext): ExecutionContext {
  const req: TenantRequest = tenant ? { tenant } : {};
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

@Controller('tenant-decorator-test')
class TenantDecoratorTestController {
  @Get('full')
  getFull(@CurrentTenant() tenant: TenantContext) {
    return tenant;
  }

  @Get('user-id')
  getUserId(@CurrentTenant('userId') userId: string) {
    return { userId };
  }

  @Get('session-id')
  getSessionId(@CurrentTenant('sessionId') sessionId: string) {
    return { sessionId };
  }
}

describe('@CurrentTenant() decorator', () => {
  it('returns full TenantContext, userId, and sessionId from ExecutionContext', () => {
    const controller = new TenantDecoratorTestController();
    const tenant: TenantContext = {
      userId: '11111111-1111-1111-1111-111111111111',
      sessionId: '22222222-2222-2222-2222-222222222222',
    };
    const ctx = createHttpExecutionContext(tenant);

    const fullFactory = getParamDecoratorFactory(controller, 'getFull');
    const userIdFactory = getParamDecoratorFactory(controller, 'getUserId');
    const sessionIdFactory = getParamDecoratorFactory(controller, 'getSessionId');

    expect(fullFactory(undefined, ctx)).toEqual(tenant);
    expect(userIdFactory('userId', ctx)).toBe(tenant.userId);
    expect(sessionIdFactory('sessionId', ctx)).toBe(tenant.sessionId);
  });

  it('throws InternalServerErrorException when req.tenant is missing', () => {
    const controller = new TenantDecoratorTestController();
    const factory = getParamDecoratorFactory(controller, 'getFull');
    const emptyCtx = createHttpExecutionContext(undefined);

    expect(() => factory(undefined, emptyCtx)).toThrow(InternalServerErrorException);
    expect(() => factory('userId', emptyCtx)).toThrow('Tenant context is missing on request.');
  });

  it('binds TenantContext and throws 500 inside a live NestJS controller when tenant is absent', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TenantDecoratorTestController],
    }).compile();

    const app: INestApplication = moduleRef.createNestApplication();
    const activeTenant: TenantContext = {
      userId: 'user-abc',
      sessionId: 'session-xyz',
    };

    app.use((req: TenantRequest & { headers?: Record<string, string> }, _res: unknown, next: () => void) => {
      if (req.headers?.['x-inject-tenant'] === 'true') {
        req.tenant = activeTenant;
      }
      next();
    });
    await app.init();

    try {
      await request(app.getHttpServer())
        .get('/tenant-decorator-test/full')
        .set('x-inject-tenant', 'true')
        .expect(200)
        .expect(activeTenant);

      await request(app.getHttpServer())
        .get('/tenant-decorator-test/user-id')
        .set('x-inject-tenant', 'true')
        .expect(200)
        .expect({ userId: activeTenant.userId });

      await request(app.getHttpServer())
        .get('/tenant-decorator-test/session-id')
        .set('x-inject-tenant', 'true')
        .expect(200)
        .expect({ sessionId: activeTenant.sessionId });

      await request(app.getHttpServer()).get('/tenant-decorator-test/full').expect(500);
    } finally {
      await app.close();
    }
  });
});

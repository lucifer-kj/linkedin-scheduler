import {
  createParamDecorator,
  InternalServerErrorException,
  type ExecutionContext,
} from '@nestjs/common';
import type { TenantContext, TenantRequest } from './tenant-session.middleware.js';

export const CurrentTenant = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext): TenantContext | string => {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const tenant = req.tenant;
    if (!tenant) {
      throw new InternalServerErrorException('Tenant context is missing on request.');
    }
    return data ? tenant[data] : tenant;
  }
);

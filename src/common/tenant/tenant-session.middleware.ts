import crypto from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export const TENANT_COOKIE_NAME = 'li_scheduler_sid';
const TENANT_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64_REGEX = /^[0-9a-f]{64}$/i;

export interface TenantContext {
  userId: string;
  sessionId: string;
}

export interface TenantCookieOptions {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  path: string;
  secure: boolean;
  maxAge: number;
}

export interface TenantRequest {
  cookies?: Record<string, string | undefined>;
  headers?: {
    cookie?: string;
    [key: string]: string | string[] | undefined;
  };
  originalUrl?: string;
  url?: string;
  tenant?: TenantContext;
}

export interface TenantResponse {
  cookie(name: string, value: string, options: TenantCookieOptions): unknown;
}

export type TenantNextFn = (err?: unknown) => void;

@Injectable()
export class TenantSessionMiddleware implements NestMiddleware<TenantRequest, TenantResponse> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService
  ) {}

  async use(req: TenantRequest, res: TenantResponse, next: TenantNextFn): Promise<void> {
    try {
      const rawCookie = this.extractCookie(req);
      const verifiedSessionId = rawCookie ? this.verifySignedSessionId(rawCookie) : null;

      let user = verifiedSessionId
        ? await this.prisma.user.findUnique({
            where: { sessionId: verifiedSessionId },
            select: { id: true, sessionId: true },
          })
        : null;

      if (!user) {
        const newSessionId = crypto.randomUUID();
        user = await this.prisma.user.create({
          data: { sessionId: newSessionId },
          select: { id: true, sessionId: true },
        });

        const signedValue = this.signSessionId(user.sessionId);
        res.cookie(TENANT_COOKIE_NAME, signedValue, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          secure: this.config.isProduction,
          maxAge: TENANT_COOKIE_MAX_AGE_MS,
        });
      }

      req.tenant = {
        userId: user.id,
        sessionId: user.sessionId,
      };
      next();
    } catch (error) {
      next(error);
    }
  }

  signSessionId(sessionId: string): string {
    const signature = crypto
      .createHmac('sha256', this.config.sessionSigningKey)
      .update(sessionId, 'utf8')
      .digest('hex');
    return `${sessionId}.${signature}`;
  }

  verifySignedSessionId(rawCookie: string): string | null {
    const parts = rawCookie.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [sessionId, signatureHex] = parts;
    if (!UUID_REGEX.test(sessionId) || !HEX_64_REGEX.test(signatureHex)) {
      return null;
    }

    const expectedBuf = crypto
      .createHmac('sha256', this.config.sessionSigningKey)
      .update(sessionId, 'utf8')
      .digest();
    const providedBuf = Buffer.from(signatureHex, 'hex');

    if (expectedBuf.length !== providedBuf.length) {
      return null;
    }

    return crypto.timingSafeEqual(expectedBuf, providedBuf) ? sessionId : null;
  }

  private extractCookie(req: TenantRequest): string | undefined {
    const parsedCookie = req.cookies?.[TENANT_COOKIE_NAME];
    if (typeof parsedCookie === 'string' && parsedCookie.length > 0) {
      return parsedCookie;
    }

    const header = req.headers?.cookie;
    if (typeof header !== 'string' || header.length === 0) {
      return undefined;
    }

    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      if (key === TENANT_COOKIE_NAME) {
        const val = part.slice(idx + 1).trim();
        try {
          return decodeURIComponent(val);
        } catch {
          return val;
        }
      }
    }

    return undefined;
  }
}

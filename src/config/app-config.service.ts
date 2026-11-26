import crypto from 'node:crypto';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import dotenv from 'dotenv';
import { parseEnv, type EnvConfig } from './env.schema.js';

@Injectable()
export class AppConfigService {
  private readonly env: EnvConfig;
  private readonly _sessionSigningKey: Buffer;

  constructor(@Optional() configService?: ConfigService<EnvConfig, true>) {
    if (configService) {
      this.env = {
        PORT: configService.get('PORT', { infer: true }),
        NODE_ENV: configService.get('NODE_ENV', { infer: true }),
        DATABASE_URL: configService.get('DATABASE_URL', { infer: true }),
        REDIS_URL: configService.get('REDIS_URL', { infer: true }),
        ENCRYPTION_MASTER_KEY: configService.get('ENCRYPTION_MASTER_KEY', { infer: true }),
        SESSION_SECRET: configService.get('SESSION_SECRET', { infer: true }),
        LINKEDIN_CLIENT_ID: configService.get('LINKEDIN_CLIENT_ID', { infer: true }),
        LINKEDIN_CLIENT_SECRET: configService.get('LINKEDIN_CLIENT_SECRET', { infer: true }),
        LINKEDIN_REDIRECT_URI: configService.get('LINKEDIN_REDIRECT_URI', { infer: true }),
        LINKEDIN_API_VERSION: configService.get('LINKEDIN_API_VERSION', { infer: true }),
        USE_MOCK_LINKEDIN: configService.get('USE_MOCK_LINKEDIN', { infer: true }),
        SIMULATE_TRANSIENT_FAILURE: configService.get('SIMULATE_TRANSIENT_FAILURE', { infer: true }),
      };
    } else {
      dotenv.config({ quiet: true });
      this.env = parseEnv(process.env);
    }

    this._sessionSigningKey = AppConfigService.deriveSessionSigningKey(
      this.env.ENCRYPTION_MASTER_KEY,
      this.env.SESSION_SECRET
    );
  }

  static fromEnv(env: EnvConfig): AppConfigService {
    const instance = Object.create(AppConfigService.prototype) as {
      env: EnvConfig;
      _sessionSigningKey: Buffer;
    };
    instance.env = env;
    instance._sessionSigningKey = AppConfigService.deriveSessionSigningKey(
      env.ENCRYPTION_MASTER_KEY,
      env.SESSION_SECRET
    );
    return instance as unknown as AppConfigService;
  }

  private static deriveSessionSigningKey(masterKeyHex: string, sessionSecret?: string): Buffer {
    if (sessionSecret) {
      return crypto.createHash('sha256').update(sessionSecret, 'utf8').digest();
    }
    return crypto
      .createHmac('sha256', Buffer.from(masterKeyHex, 'hex'))
      .update('li-scheduler-session-v1', 'utf8')
      .digest();
  }

  get port(): number {
    return this.env.PORT;
  }

  get nodeEnv(): EnvConfig['NODE_ENV'] {
    return this.env.NODE_ENV;
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }

  get databaseUrl(): string {
    return this.env.DATABASE_URL;
  }

  get redisUrl(): string {
    return this.env.REDIS_URL;
  }

  get encryptionMasterKey(): string {
    return this.env.ENCRYPTION_MASTER_KEY;
  }

  get sessionSigningKey(): Buffer {
    return this._sessionSigningKey;
  }

  get linkedinClientId(): string {
    return this.env.LINKEDIN_CLIENT_ID;
  }

  get linkedinClientSecret(): string {
    return this.env.LINKEDIN_CLIENT_SECRET;
  }

  get linkedinRedirectUri(): string {
    return this.env.LINKEDIN_REDIRECT_URI;
  }

  get linkedinApiVersion(): string {
    return this.env.LINKEDIN_API_VERSION;
  }

  get useMockLinkedin(): boolean {
    return this.env.USE_MOCK_LINKEDIN;
  }

  get simulateTransientFailure(): boolean {
    return this.env.SIMULATE_TRANSIENT_FAILURE;
  }
}

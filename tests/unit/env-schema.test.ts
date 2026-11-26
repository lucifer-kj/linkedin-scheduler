import { describe, it, expect } from 'vitest';
import { parseEnv } from '../../src/config/env.schema.js';
import { AppConfigService } from '../../src/config/app-config.service.js';

const validBaseEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/linkedin_scheduler?schema=public',
  ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

describe('envSchema & AppConfigService', () => {
  it('applies safe defaults for valid PostgreSQL configuration', () => {
    const parsed = parseEnv(validBaseEnv);

    expect(parsed.PORT).toBe(3000);
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.REDIS_URL).toBe('redis://localhost:6379');
    expect(parsed.LINKEDIN_API_VERSION).toBe('202501');
    expect(parsed.USE_MOCK_LINKEDIN).toBe(true);
    expect(parsed.SIMULATE_TRANSIENT_FAILURE).toBe(false);
    expect(parsed.SESSION_SECRET).toBeUndefined();
  });

  it('parses boolean flags safely including "false", "0", "true", "1"', () => {
    const parsed = parseEnv({
      ...validBaseEnv,
      USE_MOCK_LINKEDIN: 'false',
      SIMULATE_TRANSIENT_FAILURE: '1',
    });

    expect(parsed.USE_MOCK_LINKEDIN).toBe(false);
    expect(parsed.SIMULATE_TRANSIENT_FAILURE).toBe(true);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        USE_MOCK_LINKEDIN: 'not-a-bool',
      })
    ).toThrow(/Invalid boolean value/);
  });

  it('rejects SQLite DATABASE_URL and invalid ENCRYPTION_MASTER_KEY', () => {
    expect(() =>
      parseEnv({
        ...validBaseEnv,
        DATABASE_URL: 'file:./dev.db',
      })
    ).toThrow(/PostgreSQL/i);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        ENCRYPTION_MASTER_KEY: 'g'.repeat(64),
      })
    ).toThrow(/64-character hex/);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        ENCRYPTION_MASTER_KEY: '0123456789abcdef',
      })
    ).toThrow(/64-character hex/);
  });

  it('accepts Upstash rediss:// TLS URLs and rejects invalid REDIS_URL', () => {
    const parsed = parseEnv({
      ...validBaseEnv,
      REDIS_URL: 'rediss://default:secret@example.upstash.io:6379',
    });
    expect(parsed.REDIS_URL).toMatch(/^rediss:\/\//);

    expect(() =>
      parseEnv({
        ...validBaseEnv,
        REDIS_URL: 'http://localhost:6379',
      })
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it('derives independent domain-separated sessionSigningKey when SESSION_SECRET is omitted', () => {
    const envWithoutSecret = parseEnv({ ...validBaseEnv, SESSION_SECRET: '' });
    const configWithoutSecret = AppConfigService.fromEnv(envWithoutSecret);

    expect(configWithoutSecret.sessionSigningKey).toBeInstanceOf(Buffer);
    expect(configWithoutSecret.sessionSigningKey).toHaveLength(32);
    expect(configWithoutSecret.sessionSigningKey.toString('hex')).not.toBe(
      validBaseEnv.ENCRYPTION_MASTER_KEY
    );

    const envWithSecret = parseEnv({
      ...validBaseEnv,
      SESSION_SECRET: 'super-secret-session-signing-key-123',
    });
    const configWithSecret = AppConfigService.fromEnv(envWithSecret);
    expect(configWithSecret.sessionSigningKey.toString('hex')).not.toBe(
      configWithoutSecret.sessionSigningKey.toString('hex')
    );
  });
});

import { PassThrough } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { PinoLoggerService } from '../../src/common/logger/pino-logger.service.js';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { parseEnv } from '../../src/config/env.schema.js';

function createConfig(nodeEnv: 'production' | 'test' | 'development'): AppConfigService {
  return AppConfigService.fromEnv(
    parseEnv({
      NODE_ENV: nodeEnv,
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/linkedin_scheduler?schema=public',
      ENCRYPTION_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SESSION_SECRET: 'test-session-secret-32-chars-minimum',
    })
  );
}

function createCapturingLogger(nodeEnv: 'production' | 'test' = 'production') {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  const logger = new PinoLoggerService(createConfig(nodeEnv), stream);
  return {
    logger,
    getLines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    getRawOutput: () => chunks.join(''),
  };
}

describe('PinoLoggerService', () => {
  it('sets level to "silent" in test environment and suppresses output', () => {
    const { logger, getRawOutput } = createCapturingLogger('test');
    expect(logger.getPino().level).toBe('silent');

    logger.log('Should not appear', 'TestContext');
    logger.error('Should not appear either', new Error('hidden'));
    expect(getRawOutput()).toBe('');
  });

  it('redacts top-level secrets and req/res headers in production JSON output', () => {
    const { logger, getLines, getRawOutput } = createCapturingLogger('production');
    expect(logger.getPino().level).toBe('info');

    logger.log({
      accessToken: 'RAW_TOP_ACCESS_TOKEN',
      clientSecret: 'RAW_TOP_CLIENT_SECRET',
      cookie: 'RAW_TOP_COOKIE',
      authorization: 'Bearer RAW_TOP_AUTH',
      encryptionMasterKey: 'RAW_MASTER_KEY',
      sessionSigningKey: 'RAW_SIGNING_KEY',
      encryptedAccessToken: 'RAW_ENCRYPTED_ACCESS_TOKEN',
      encryptedClientSecret: 'RAW_ENCRYPTED_CLIENT_SECRET',
      req: {
        headers: {
          cookie: 'li_scheduler_sid=RAW_REQ_COOKIE',
          authorization: 'Bearer RAW_REQ_AUTH',
        },
      },
      res: {
        headers: {
          'set-cookie': ['li_scheduler_sid=RAW_RES_SET_COOKIE'],
        },
      },
      safeField: 'visible-value',
    });

    const raw = getRawOutput();
    for (const secret of [
      'RAW_TOP_ACCESS_TOKEN',
      'RAW_TOP_CLIENT_SECRET',
      'RAW_TOP_COOKIE',
      'RAW_TOP_AUTH',
      'RAW_MASTER_KEY',
      'RAW_SIGNING_KEY',
      'RAW_ENCRYPTED_ACCESS_TOKEN',
      'RAW_ENCRYPTED_CLIENT_SECRET',
      'RAW_REQ_COOKIE',
      'RAW_REQ_AUTH',
      'RAW_RES_SET_COOKIE',
    ]) {
      expect(raw).not.toContain(secret);
    }

    const [entry] = getLines();
    expect(entry.accessToken).toBe('[REDACTED]');
    expect(entry.clientSecret).toBe('[REDACTED]');
    expect(entry.cookie).toBe('[REDACTED]');
    expect(entry.authorization).toBe('[REDACTED]');
    expect(entry.encryptionMasterKey).toBe('[REDACTED]');
    expect(entry.sessionSigningKey).toBe('[REDACTED]');
    expect(entry.encryptedAccessToken).toBe('[REDACTED]');
    expect(entry.encryptedClientSecret).toBe('[REDACTED]');
    expect((entry.req as { headers: Record<string, unknown> }).headers.cookie).toBe('[REDACTED]');
    expect((entry.req as { headers: Record<string, unknown> }).headers.authorization).toBe(
      '[REDACTED]'
    );
    expect((entry.res as { headers: Record<string, unknown> }).headers['set-cookie']).toBe(
      '[REDACTED]'
    );
    expect(entry.safeField).toBe('visible-value');
  });

  it('redacts depth >= 2 nested secrets on Errors and HTTP client metadata', () => {
    const { logger, getLines, getRawOutput } = createCapturingLogger('production');

    const httpError = Object.assign(new Error('LinkedIn HTTP failed'), {
      response: {
        status: 401,
        headers: {
          authorization: 'Bearer DEEP_AXIOS_AUTH',
          cookie: 'DEEP_AXIOS_COOKIE',
          'set-cookie': 'DEEP_SET_COOKIE',
        },
      },
      config: {
        headers: {
          authorization: 'Bearer DEEP_CONFIG_AUTH',
          cookie: 'DEEP_CONFIG_COOKIE',
        },
      },
      request: {
        headers: {
          authorization: 'Bearer DEEP_REQUEST_AUTH',
          cookie: 'DEEP_REQUEST_COOKIE',
        },
      },
      nested: {
        deep: {
          accessToken: 'DEEP_NESTED_TOKEN',
          clientSecret: 'DEEP_NESTED_SECRET',
        },
      },
      very: {
        nested: {
          deep: {
            accessToken: 'DEPTH4_NESTED_TOKEN',
          },
        },
      },
    });

    logger.error(httpError, 'LinkedInClient');

    const raw = getRawOutput();
    for (const secret of [
      'DEEP_AXIOS_AUTH',
      'DEEP_AXIOS_COOKIE',
      'DEEP_SET_COOKIE',
      'DEEP_CONFIG_AUTH',
      'DEEP_CONFIG_COOKIE',
      'DEEP_REQUEST_AUTH',
      'DEEP_REQUEST_COOKIE',
      'DEEP_NESTED_TOKEN',
      'DEEP_NESTED_SECRET',
      'DEPTH4_NESTED_TOKEN',
    ]) {
      expect(raw).not.toContain(secret);
    }

    const [entry] = getLines();
    expect(entry.context).toBe('LinkedInClient');
    const err = entry.err as {
      message: string;
      response: { status: number; headers: Record<string, unknown> };
      config: { headers: Record<string, unknown> };
      request: { headers: Record<string, unknown> };
      nested: { deep: Record<string, unknown> };
      very: { nested: { deep: Record<string, unknown> } };
    };
    expect(err.message).toBe('LinkedIn HTTP failed');
    expect(err.response.status).toBe(401);
    expect(err.response.headers.authorization).toBe('[REDACTED]');
    expect(err.response.headers.cookie).toBe('[REDACTED]');
    expect(err.response.headers['set-cookie']).toBe('[REDACTED]');
    expect(err.config.headers.authorization).toBe('[REDACTED]');
    expect(err.config.headers.cookie).toBe('[REDACTED]');
    expect(err.request.headers.authorization).toBe('[REDACTED]');
    expect(err.request.headers.cookie).toBe('[REDACTED]');
    expect(err.nested.deep.accessToken).toBe('[REDACTED]');
    expect(err.nested.deep.clientSecret).toBe('[REDACTED]');
    expect(err.very.nested.deep.accessToken).toBe('[REDACTED]');
  });

  it('merges plain metadata objects and Error params passed after a string message while still redacting secrets', () => {
    const { logger, getLines, getRawOutput } = createCapturingLogger('production');

    logger.log('msg', { postId: '123', accessToken: 'SECRET_PARAM_TOKEN' }, 'PostsService');

    const nestedErr = Object.assign(new Error('Upstream 502'), {
      response: {
        headers: {
          authorization: 'Bearer PARAM_ERR_SECRET',
        },
      },
    });
    logger.error('Failed publish', { postId: '456' }, nestedErr, 'PostsProcessor');

    const raw = getRawOutput();
    expect(raw).not.toContain('SECRET_PARAM_TOKEN');
    expect(raw).not.toContain('PARAM_ERR_SECRET');

    const lines = getLines();
    expect(lines).toHaveLength(2);

    expect(lines[0]).toMatchObject({
      msg: 'msg',
      postId: '123',
      accessToken: '[REDACTED]',
      context: 'PostsService',
    });

    expect(lines[1]).toMatchObject({
      msg: 'Failed publish',
      postId: '456',
      context: 'PostsProcessor',
      err: {
        message: 'Upstream 502',
        response: {
          headers: {
            authorization: '[REDACTED]',
          },
        },
      },
    });
  });
});

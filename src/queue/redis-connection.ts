import { Redis } from 'ioredis';
import type { PinoLoggerService } from '../common/logger/pino-logger.service.js';

export interface BullRedisOptions {
  maxRetriesPerRequest: null;
  enableReadyCheck: false;
  lazyConnect?: boolean;
  tls?: {
    servername: string;
  };
}

export function buildBullRedisOptions(
  redisUrl: string,
  options?: { isTest?: boolean }
): BullRedisOptions {
  let parsed: URL;
  try {
    parsed = new URL(redisUrl);
  } catch {
    throw new Error(`Invalid REDIS_URL: "${redisUrl}"`);
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis protocol "${parsed.protocol}". Expected redis:// or rediss://.`);
  }

  const isTls = parsed.protocol === 'rediss:';

  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...(options?.isTest ? { lazyConnect: true } : {}),
    ...(isTls ? { tls: { servername: parsed.hostname } } : {}),
  };
}

export function createBullRedisClient(
  redisUrl: string,
  options?: { isTest?: boolean; logger?: PinoLoggerService }
): Redis {
  const redisOptions = buildBullRedisOptions(redisUrl, options);
  const client = new Redis(redisUrl, redisOptions);

  client.on('error', (error: Error) => {
    if (options?.logger) {
      options.logger.warn(`Redis connection error: ${error.message}`, 'BullMQRedis');
    }
  });

  return client;
}

import { Inject, Injectable, Optional, type LoggerService } from '@nestjs/common';
import pino, {
  type DestinationStream,
  type Logger as PinoInstance,
  type LoggerOptions,
} from 'pino';
import { AppConfigService } from '../../config/app-config.service.js';

export const PINO_DESTINATION = Symbol('PINO_DESTINATION');

const SENSITIVE_FIELDS = [
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'encryptionMasterKey',
  'ENCRYPTION_MASTER_KEY',
  'sessionSigningKey',
  'SESSION_SECRET',
  'encryptedAccessToken',
  'encryptedClientSecret',
  'cookie',
  'authorization',
] as const;

const WILDCARD_DEPTH_PREFIXES = ['', '*.', '*.*.', '*.*.*.', '*.*.*.*.'] as const;

export const REDACT_PATHS: string[] = Array.from(
  new Set([
    ...WILDCARD_DEPTH_PREFIXES.flatMap((prefix) =>
      SENSITIVE_FIELDS.map((field) => `${prefix}${field}`)
    ),
    ...WILDCARD_DEPTH_PREFIXES.map((prefix) => `${prefix}["set-cookie"]`),
    'req.headers.cookie',
    'req.headers.authorization',
    'req.headers["set-cookie"]',
    'res.headers.cookie',
    'res.headers.authorization',
    'res.headers["set-cookie"]',
    'headers.cookie',
    'headers.authorization',
    'headers["set-cookie"]',
    '*.headers.cookie',
    '*.headers.authorization',
    '*.headers["set-cookie"]',
    '*.*.headers.cookie',
    '*.*.headers.authorization',
    '*.*.headers["set-cookie"]',
    '*.*.*.headers.cookie',
    '*.*.*.headers.authorization',
    '*.*.*.headers["set-cookie"]',
    'err.response.headers.authorization',
    'err.response.headers.cookie',
    'err.response.headers["set-cookie"]',
    'err.config.headers.authorization',
    'err.config.headers.cookie',
    'err.request.headers.authorization',
    'err.request.headers.cookie',
  ])
);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly logger: PinoInstance;

  constructor(
    @Optional() config?: AppConfigService,
    @Optional() @Inject(PINO_DESTINATION) destination?: DestinationStream
  ) {
    const nodeEnv = config?.nodeEnv ?? process.env.NODE_ENV ?? 'development';
    const level = nodeEnv === 'test' ? 'silent' : nodeEnv === 'production' ? 'info' : 'debug';

    const options: LoggerOptions = {
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      transport:
        !destination && nodeEnv !== 'production' && nodeEnv !== 'test'
          ? {
              target: 'pino-pretty',
              options: {
                colorize: true,
                singleLine: true,
              },
            }
          : undefined,
    };

    this.logger = destination ? pino(options, destination) : pino(options);
  }

  getPino(): PinoInstance {
    return this.logger;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emit('fatal', message, optionalParams);
  }

  private emit(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal',
    message: unknown,
    optionalParams: unknown[]
  ): void {
    const meta: Record<string, unknown> = {};
    let trace: string | undefined;

    const lastIndex = optionalParams.length - 1;
    const lastParam = lastIndex >= 0 ? optionalParams[lastIndex] : undefined;
    const hasTrailingContext = typeof lastParam === 'string';

    for (let i = 0; i < optionalParams.length; i += 1) {
      const param = optionalParams[i];
      if (i === lastIndex && hasTrailingContext) {
        continue;
      }
      if (param instanceof Error) {
        meta.err = param;
      } else if (isPlainRecord(param)) {
        Object.assign(meta, param);
      }
    }

    if (hasTrailingContext) {
      meta.context = lastParam;
    }

    if (level === 'error' && optionalParams.length >= 2 && typeof optionalParams[0] === 'string') {
      trace = optionalParams[0];
    }

    if (message instanceof Error) {
      this.logger[level]({ ...meta, err: message, ...(trace ? { trace } : {}) }, message.message);
      return;
    }

    if (typeof message === 'object' && message !== null) {
      const msgText =
        typeof optionalParams[0] === 'string' && optionalParams.length > 1
          ? optionalParams[0]
          : undefined;
      this.logger[level](
        { ...meta, ...(message as Record<string, unknown>), ...(trace ? { trace } : {}) },
        msgText
      );
      return;
    }

    this.logger[level](
      trace ? { ...meta, trace } : meta,
      typeof message === 'string' ? message : String(message)
    );
  }
}

import { z } from 'zod';

export function envBoolean(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return defaultValue;
      }
      if (typeof value === 'boolean') {
        return value;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === '') {
        return defaultValue;
      }
      if (normalized === 'true' || normalized === '1') {
        return true;
      }
      if (normalized === 'false' || normalized === '0') {
        return false;
      }
      ctx.addIssue({
        code: 'custom',
        message: `Invalid boolean value "${value}". Expected true, false, 1, or 0.`,
      });
      return z.NEVER;
    });
}

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => /^postgres(ql)?:\/\//i.test(value),
      'DATABASE_URL must be a valid PostgreSQL connection string (postgresql:// or postgres://)'
    ),
  REDIS_URL: z
    .string()
    .refine(
      (value) => /^rediss?:\/\//i.test(value),
      'REDIS_URL must start with redis:// or rediss://'
    )
    .default('redis://localhost:6379'),
  ENCRYPTION_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_MASTER_KEY must be a 64-character hex string (32 bytes)'),
  SESSION_SECRET: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(16, 'SESSION_SECRET must be at least 16 characters when provided').optional()
  ),
  LINKEDIN_CLIENT_ID: z.string().min(1).default('mock_client_id'),
  LINKEDIN_CLIENT_SECRET: z.string().min(1).default('mock_client_secret'),
  LINKEDIN_REDIRECT_URI: z
    .string()
    .url('LINKEDIN_REDIRECT_URI must be a valid URL')
    .default('http://localhost:3000/api/auth/linkedin/callback'),
  LINKEDIN_API_VERSION: z
    .string()
    .regex(/^\d{6}$/, 'LINKEDIN_API_VERSION must be YYYYMM format')
    .default('202501'),
  USE_MOCK_LINKEDIN: envBoolean(true),
  SIMULATE_TRANSIENT_FAILURE: envBoolean(false),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function parseEnv(rawEnv: Record<string, string | undefined> = process.env): EnvConfig {
  const result = envSchema.safeParse(rawEnv);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}

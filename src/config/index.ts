import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:./dev.db'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // 32 bytes hex = 64 characters
  ENCRYPTION_MASTER_KEY: z.string().min(64).max(64),
  LINKEDIN_CLIENT_ID: z.string().default('mock_client_id'),
  LINKEDIN_CLIENT_SECRET: z.string().default('mock_client_secret'),
  LINKEDIN_REDIRECT_URI: z.string().default('http://localhost:3000/api/auth/linkedin/callback'),
  USE_MOCK_LINKEDIN: z.string().default('true').transform((v) => v === 'true'),
  SIMULATE_TRANSIENT_FAILURE: z.string().default('false').transform((v) => v === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

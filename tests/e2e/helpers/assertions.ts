import crypto from 'node:crypto';
import { expect } from 'vitest';
import type { HttpResponse, SessionHttpClient } from './http-client.js';

export interface HealthResponse {
  status: 'ok' | 'degraded' | string;
  db?: 'up' | 'down' | string;
  redis?: 'up' | 'down' | string;
  mode: 'mock' | 'live' | string;
  simulateTransientFailure: boolean;
  recoveredCount?: number;
  timestamp: string;
}

export interface AccountInfo {
  id: string;
  linkedinName: string;
  linkedinPersonUrn: string;
  expiresAt: string;
  createdAt: string;
}

export interface AccountResponse {
  connected: boolean;
  isExpired?: boolean;
  hasCustomCredentials?: boolean;
  mode?: 'mock' | 'live' | string;
  account: AccountInfo | null;
}

export interface PostRecord {
  id: string;
  userId?: string;
  linkedinAccountId?: string | null;
  content: string;
  scheduledFor: string;
  status: string;
  idempotencyKey: string;
  bullmqJobId?: string | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  externalPostUrn: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface PostsListResponse {
  posts: PostRecord[];
}

export interface ScheduleResponse {
  message?: string;
  post: PostRecord;
}

export interface ToggleSimulationResponse {
  simulateTransientFailure: boolean;
  message?: string;
}

export function uniqueContent(prefix = 'E2E Post'): string {
  return `${prefix} ${crypto.randomUUID()}`;
}

export function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export function pastIso(offsetMs: number): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 150;
  const label = options.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;

  let lastValue: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      if (predicate(lastValue)) {
        return lastValue;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}. Last value: ${JSON.stringify(lastValue)}${
      lastError ? `; last error: ${String(lastError)}` : ''
    }`,
  );
}

export async function waitForPostStatus(
  client: SessionHttpClient,
  postId: string,
  targetStatuses: string[],
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PostRecord> {
  const result = await pollUntil(
    async () => {
      const res = await client.get<PostsListResponse>('/api/posts');
      expect(res.status).toBe(200);
      return res.data.posts.find((p) => p.id === postId) ?? null;
    },
    (post) => post !== null && targetStatuses.includes(post.status),
    {
      timeoutMs: options.timeoutMs ?? 15_000,
      intervalMs: options.intervalMs ?? 150,
      label: `post ${postId} to reach status [${targetStatuses.join(', ')}]`,
    },
  );
  if (!result) {
    throw new Error(`Post ${postId} not found`);
  }
  return result;
}

export async function connectMockTenant(client: SessionHttpClient): Promise<{
  state: string;
  authUrl: URL;
  callbackRes: HttpResponse<unknown>;
  accountRes: HttpResponse<AccountResponse>;
}> {
  const urlRes = await client.get<{ url: string }>('/api/auth/linkedin/url');
  expect(urlRes.status).toBe(200);
  expect(typeof urlRes.data.url).toBe('string');

  const authUrl = new URL(urlRes.data.url, client.baseUrl);
  const state = authUrl.searchParams.get('state') ?? '';
  expect(state.length).toBeGreaterThan(0);

  const callbackRes = await client.get(`${authUrl.pathname}${authUrl.search}`);
  expect(callbackRes.status).toBeGreaterThanOrEqual(300);
  expect(callbackRes.status).toBeLessThan(400);
  expect(callbackRes.location).toBeTruthy();

  const redirectTarget = new URL(callbackRes.location!, client.baseUrl);
  expect(redirectTarget.searchParams.get('auth')).toBe('success');

  const accountRes = await client.get<AccountResponse>('/api/account');
  expect(accountRes.status).toBe(200);
  expect(accountRes.data.connected).toBe(true);

  return { state, authUrl, callbackRes, accountRes };
}

export async function ensureSimulateFailure(
  client: SessionHttpClient,
  desired: boolean,
): Promise<boolean> {
  const healthBefore = await client.get<HealthResponse>('/api/health');
  expect(healthBefore.status).toBe(200);

  if (healthBefore.data.simulateTransientFailure !== desired) {
    const toggleRes = await client.post<ToggleSimulationResponse>(
      '/api/test/toggle-simulate-failure',
      { enabled: desired, simulateTransientFailure: desired },
    );
    assertPostActionStatus(toggleRes.status);
    expect(toggleRes.data.simulateTransientFailure).toBe(desired);
  }

  const healthAfter = await client.get<HealthResponse>('/api/health');
  expect(healthAfter.status).toBe(200);
  expect(healthAfter.data.simulateTransientFailure).toBe(desired);
  return healthAfter.data.simulateTransientFailure;
}

export function assertPostActionStatus(status: number): void {
  expect([200, 201]).toContain(status);
}

export function assertErrorBody(data: unknown): void {
  expect(data).toBeTruthy();
  expect(typeof data).toBe('object');
  const record = data as Record<string, unknown>;
  expect(Boolean(record.error || record.message)).toBe(true);
}

export function assertAuthErrorOutcome(
  callbackRes: HttpResponse<unknown>,
  baseUrl: string,
): void {
  if (callbackRes.status >= 300 && callbackRes.status < 400) {
    expect(callbackRes.location).toBeTruthy();
    const redirectUrl = new URL(callbackRes.location!, baseUrl);
    expect(redirectUrl.searchParams.get('auth')).toBe('error');
    expect(redirectUrl.searchParams.get('message')).toBeTruthy();
  } else {
    expect([400, 403]).toContain(callbackRes.status);
  }
}

export function assertNoSecretsInText(text: string, extraForbidden: string[] = []): void {
  const forbiddenPatterns = [
    'ENCRYPTION_MASTER_KEY',
    'DATABASE_URL',
    'LINKEDIN_CLIENT_SECRET',
    'SESSION_SECRET',
    'REDIS_URL',
    'encryptedAccessToken',
    'tokenIv',
    'tokenAuthTag',
    'encryptedClientSecret',
    'clientSecretIv',
    'clientSecretAuthTag',
    ...extraForbidden,
  ];
  for (const pattern of forbiddenPatterns) {
    expect(text).not.toContain(pattern);
  }
}

export function isValidSidFormat(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/i.test(
    value,
  );
}

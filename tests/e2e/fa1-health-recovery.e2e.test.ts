import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertNoSecretsInText,
  connectMockTenant,
  ensureSimulateFailure,
  futureIso,
  pastIso,
  pollUntil,
  uniqueContent,
  waitForPostStatus,
  type HealthResponse,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA1: Health Check & Overdue Post Recovery',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    afterAll(async () => {
      const cleanupClient = createSessionClient(baseUrl);
      await ensureSimulateFailure(cleanupClient, false);
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: GET /api/health returns 200 with status ok, db up, redis up', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health');

      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
      expect(res.data.db).toBe('up');
      expect(res.data.redis).toBe('up');
    });

    it('T1.2: GET /api/health returns valid mode, boolean simulateTransientFailure, recoveredCount >= 0, and ISO timestamp', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health');

      expect(res.status).toBe(200);
      expect(['mock', 'live']).toContain(res.data.mode);
      expect(typeof res.data.simulateTransientFailure).toBe('boolean');
      expect(typeof res.data.recoveredCount).toBe('number');
      expect(res.data.recoveredCount).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(res.data.timestamp))).toBe(false);
    });

    it('T1.3: Due/overdue post + GET /api/health recovers and publishes cleanly', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA1 Overdue Recovery');
      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: pastIso(500),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const healthRes = await client.get<HealthResponse>('/api/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.data.recoveredCount).toBeGreaterThanOrEqual(0);

      const published = await waitForPostStatus(client, postId, ['published']);
      expect(published.status).toBe('published');
      expect(published.externalPostUrn).toBeTruthy();
      expect(published.publishedAt).toBeTruthy();
    });

    it('T1.4: Repeated GET /api/health calls do not duplicate-publish already-published posts', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA1 Idempotent Health');
      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(150),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const published = await waitForPostStatus(client, postId, ['published']);
      const firstUrn = published.externalPostUrn;
      const firstPublishedAt = published.publishedAt;

      const h1 = await client.get<HealthResponse>('/api/health');
      const h2 = await client.get<HealthResponse>('/api/health');
      expect(h1.status).toBe(200);
      expect(h2.status).toBe(200);
      expect(h2.data.recoveredCount).toBe(0);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const matches = listRes.data.posts.filter((p) => p.id === postId);
      expect(matches).toHaveLength(1);
      expect(matches[0].externalPostUrn).toBe(firstUrn);
      expect(matches[0].publishedAt).toBe(firstPublishedAt);
    });

    it('T1.5: GET /api/health responds with application/json within latency budget (< 2000ms)', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health');

      expect(res.status).toBe(200);
      expect(res.contentType.toLowerCase()).toContain('application/json');
      expect(res.durationMs).toBeLessThan(2000);
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: POST /api/health returns 404 or 405 (never 200 or 500)', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.post('/api/health', {});

      expect([404, 405]).toContain(res.status);
    });

    it('T2.2: GET /api/health with garbage li_scheduler_sid cookie still returns 200 ok', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health', {
        rawCookie: 'li_scheduler_sid=garbage.invalid_signature_value',
      });

      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
    });

    it('T2.3: GET /api/health?unknown=1&foo=bar ignores unexpected query params cleanly', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health?unknown=1&foo=bar');

      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ok');
      expect(res.data.db).toBe('up');
    });

    it('T2.4: GET /api/health leaks zero secrets or internal credentials', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<HealthResponse>('/api/health');

      expect(res.status).toBe(200);
      assertNoSecretsInText(res.text);
    });

    it('T2.5: GET /api/health accurately mirrors simulateTransientFailure transitions', async () => {
      const client = createSessionClient(baseUrl);
      await ensureSimulateFailure(client, false);

      try {
        await ensureSimulateFailure(client, true);
        const duringRes = await pollUntil(
          () => client.get<HealthResponse>('/api/health'),
          (r) => r.status === 200 && r.data.simulateTransientFailure === true,
          { timeoutMs: 5000, intervalMs: 100, label: 'health simulateTransientFailure=true' },
        );
        expect(duringRes.data.simulateTransientFailure).toBe(true);
      } finally {
        await ensureSimulateFailure(client, false);
      }

      const afterRes = await client.get<HealthResponse>('/api/health');
      expect(afterRes.status).toBe(200);
      expect(afterRes.data.simulateTransientFailure).toBe(false);
    });
  },
);

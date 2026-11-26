import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertErrorBody,
  assertPostActionStatus,
  connectMockTenant,
  ensureSimulateFailure,
  futureIso,
  pollUntil,
  uniqueContent,
  waitForPostStatus,
  type HealthResponse,
  type PostsListResponse,
  type ScheduleResponse,
  type ToggleSimulationResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA7: Transient 503 / 429 Retries & Permanent UnrecoverableError',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(async () => {
      baseUrl = getE2eBaseUrl();
      const client = createSessionClient(baseUrl);
      await ensureSimulateFailure(client, false);
    });

    afterEach(async () => {
      const client = createSessionClient(baseUrl);
      await ensureSimulateFailure(client, false);
    });

    afterAll(async () => {
      const client = createSessionClient(baseUrl);
      await ensureSimulateFailure(client, false);
    });

    describe('Simulation & Retry Behavior', { concurrent: false }, () => {
      // Tier 1: Happy Path (5 tests)
      it('T1.1: POST /api/test/toggle-simulate-failure toggles boolean and returns message', async () => {
        const client = createSessionClient(baseUrl);

        const resOn = await client.post<ToggleSimulationResponse>(
          '/api/test/toggle-simulate-failure',
          { enabled: true, simulateTransientFailure: true },
        );
        assertPostActionStatus(resOn.status);
        expect(resOn.data.simulateTransientFailure).toBe(true);
        expect(typeof resOn.data.message).toBe('string');

        const resOff = await client.post<ToggleSimulationResponse>(
          '/api/test/toggle-simulate-failure',
          { enabled: false, simulateTransientFailure: false },
        );
        assertPostActionStatus(resOff.status);
        expect(resOff.data.simulateTransientFailure).toBe(false);
      });

      it('T1.2: Setting simulation ON/OFF updates GET /api/health simulateTransientFailure', async () => {
        const client = createSessionClient(baseUrl);

        await ensureSimulateFailure(client, true);
        const healthOn = await client.get<HealthResponse>('/api/health');
        expect(healthOn.status).toBe(200);
        expect(healthOn.data.simulateTransientFailure).toBe(true);

        await ensureSimulateFailure(client, false);
        const healthOff = await client.get<HealthResponse>('/api/health');
        expect(healthOff.status).toBe(200);
        expect(healthOff.data.simulateTransientFailure).toBe(false);
      });

      it('T1.3: With simulation ON, immediate post records retryCount >= 1 and lastError containing 503', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);
        await ensureSimulateFailure(client, true);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('FA7 Retry Telemetry'),
          scheduledFor: futureIso(150),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        let saw503Error = false;
        const retried = await pollUntil(
          async () => {
            const listRes = await client.get<PostsListResponse>('/api/posts');
            expect(listRes.status).toBe(200);
            const found = listRes.data.posts.find((p) => p.id === postId) ?? null;
            if (found?.lastError && found.lastError.includes('503')) {
              saw503Error = true;
            }
            return found;
          },
          (post) =>
            post !== null &&
            post.retryCount >= 1 &&
            (saw503Error || post.status === 'published'),
          { timeoutMs: 15_000, intervalMs: 50, label: 'retryCount >= 1 and 503 lastError' },
        );

        expect(retried!.retryCount).toBeGreaterThanOrEqual(1);
        expect(saw503Error).toBe(true);

        // Wait for recovery to settle before next test
        await waitForPostStatus(client, postId, ['published']);
      });

      it('T1.4: Simulated 503 post auto-recovers via backoff to status published with externalPostUrn', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);
        await ensureSimulateFailure(client, true);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('FA7 Auto Recover'),
          scheduledFor: futureIso(150),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        const published = await waitForPostStatus(client, postId, ['published'], {
          timeoutMs: 18_000,
          intervalMs: 100,
        });
        expect(published.status).toBe('published');
        expect(published.retryCount).toBeGreaterThanOrEqual(1);
        expect(published.externalPostUrn).toBeTruthy();
        expect(published.publishedAt).toBeTruthy();
      });

      it('T1.5: Disabling simulation allows next post to publish cleanly with retryCount 0 and lastError null', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);
        await ensureSimulateFailure(client, false);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('FA7 Clean Publish'),
          scheduledFor: futureIso(150),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        const published = await waitForPostStatus(client, postId, ['published']);
        expect(published.status).toBe('published');
        expect(published.retryCount).toBe(0);
        expect(published.lastError).toBeNull();
      });

      // Tier 2: Boundary / Invalid Input / Edge (5 tests)
      it('T2.1: POST /api/test/toggle-simulate-failure with empty object {} toggles cleanly without 500', async () => {
        const client = createSessionClient(baseUrl);
        await ensureSimulateFailure(client, false);

        const toggledOn = await client.post<ToggleSimulationResponse>(
          '/api/test/toggle-simulate-failure',
          {},
        );
        assertPostActionStatus(toggledOn.status);
        expect(toggledOn.data.simulateTransientFailure).toBe(true);

        const toggledOff = await client.post<ToggleSimulationResponse>(
          '/api/test/toggle-simulate-failure',
          {},
        );
        assertPostActionStatus(toggledOff.status);
        expect(toggledOff.data.simulateTransientFailure).toBe(false);
      });

      it('T2.2: POST /api/test/toggle-simulate-failure with invalid enabled type ("yes") does not 500', async () => {
        const client = createSessionClient(baseUrl);
        const res = await client.post('/api/test/toggle-simulate-failure', {
          enabled: 'yes',
        });

        expect([200, 201, 400]).toContain(res.status);
        expect(res.status).not.toBe(500);
      });

      it('T2.3: Scheduling +2500ms then disconnecting before execution triggers permanent failure (status failed, retryCount 0)', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('FA7 Unrecoverable Disconnect'),
          scheduledFor: futureIso(2500),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        const discRes = await client.post('/api/account/disconnect', {});
        assertPostActionStatus(discRes.status);

        const failedPost = await waitForPostStatus(client, postId, ['failed'], {
          timeoutMs: 15_000,
          intervalMs: 150,
        });
        expect(failedPost.status).toBe('failed');
        expect(failedPost.retryCount).toBe(0);
        expect(failedPost.lastError).toBeTruthy();
        expect(failedPost.externalPostUrn).toBeNull();
      });

      it('T2.4: A failed post rejects POST /api/posts/:id/cancel (400) and is ignored by /api/health recovery', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('FA7 Failed Post Guard'),
          scheduledFor: futureIso(2500),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        await client.post('/api/account/disconnect', {});
        await waitForPostStatus(client, postId, ['failed']);

        const cancelFailedRes = await client.post(`/api/posts/${postId}/cancel`, {});
        expect(cancelFailedRes.status).toBe(400);
        assertErrorBody(cancelFailedRes.data);

        const healthRes = await client.get<HealthResponse>('/api/health');
        expect(healthRes.status).toBe(200);

        const listRes = await client.get<PostsListResponse>('/api/posts');
        const stillFailed = listRes.data.posts.find((p) => p.id === postId);
        expect(stillFailed).toBeDefined();
        expect(stillFailed!.status).toBe('failed');
      });

      it('T2.5: Repeated toggles maintain boolean consistency and restore false cleanly', async () => {
        const client = createSessionClient(baseUrl);
        await ensureSimulateFailure(client, false);

        for (let i = 0; i < 4; i++) {
          const expected = i % 2 === 0;
          const res = await client.post<ToggleSimulationResponse>(
            '/api/test/toggle-simulate-failure',
            {},
          );
          assertPostActionStatus(res.status);
          expect(res.data.simulateTransientFailure).toBe(expected);
        }

        const healthRes = await client.get<HealthResponse>('/api/health');
        expect(healthRes.status).toBe(200);
        expect(healthRes.data.simulateTransientFailure).toBe(false);
      });
    });
  },
);

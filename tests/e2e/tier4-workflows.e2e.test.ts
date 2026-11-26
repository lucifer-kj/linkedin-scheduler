import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertNoSecretsInText,
  assertPostActionStatus,
  connectMockTenant,
  ensureSimulateFailure,
  futureIso,
  isValidSidFormat,
  pollUntil,
  sleep,
  uniqueContent,
  waitForPostStatus,
  type AccountResponse,
  type HealthResponse,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';
import { isValidHtmlDocument } from './helpers/static-bundle.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'Tier 4: Real-World Multi-Feature End-User Workflows',
  { timeout: 30_000 },
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

    describe('Evaluation Workflows', { concurrent: false }, () => {
      it('W1: First-time evaluator happy path (UI -> health -> cookie -> mock OAuth -> schedule -> publish -> 409 dedupe)', async () => {
        const client = createSessionClient(baseUrl);

        // 1. Load static frontend
        const pageRes = await client.get('/');
        expect(pageRes.status).toBe(200);
        expect(isValidHtmlDocument(pageRes.text)).toBe(true);

        // 2. Check system health
        const healthRes = await client.get<HealthResponse>('/api/health');
        expect(healthRes.status).toBe(200);
        expect(healthRes.data.status).toBe('ok');

        // 3. Inspect initial account -> issues session cookie
        const initialAccount = await client.get<AccountResponse>('/api/account');
        expect(initialAccount.status).toBe(200);
        expect(initialAccount.data.connected).toBe(false);
        expect(isValidSidFormat(client.getCookie('li_scheduler_sid') ?? '')).toBe(true);

        // 4. Connect via mock LinkedIn OAuth
        await connectMockTenant(client);

        // 5. Schedule immediate post and observe publish
        const content = uniqueContent('W1 Evaluator Post');
        const scheduledFor = futureIso(200);
        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content,
          scheduledFor,
        });
        expect(schedRes.status).toBe(201);

        const published = await waitForPostStatus(client, schedRes.data.post.id, ['published']);
        expect(published.externalPostUrn).toBeTruthy();
        expect(published.publishedAt).toBeTruthy();

        // 6. Verify duplicate protection (409)
        const dupRes = await client.post('/api/posts/schedule', {
          content,
          scheduledFor,
        });
        expect(dupRes.status).toBe(409);
      });

      it('W2: Resilience demo walkthrough (connect -> 503 ON -> retry observed -> auto-recover -> 503 OFF -> clean publish)', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        // 1. Enable 503 failure simulation and verify /api/health
        await ensureSimulateFailure(client, true);

        // 2. Schedule post and observe retry telemetry
        const retryPostRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('W2 Resilient Retry'),
          scheduledFor: futureIso(150),
        });
        expect(retryPostRes.status).toBe(201);
        const retryPostId = retryPostRes.data.post.id;

        let saw503 = false;
        await pollUntil(
          async () => {
            const listRes = await client.get<PostsListResponse>('/api/posts');
            const found = listRes.data.posts.find((p) => p.id === retryPostId) ?? null;
            if (found?.lastError && found.lastError.includes('503')) {
              saw503 = true;
            }
            return found;
          },
          (p) => p !== null && p.retryCount >= 1 && (saw503 || p.status === 'published'),
          { timeoutMs: 15_000, intervalMs: 50, label: 'W2 retry telemetry' },
        );
        expect(saw503).toBe(true);

        // 3. Auto-recover to published
        const recovered = await waitForPostStatus(client, retryPostId, ['published'], {
          timeoutMs: 18_000,
          intervalMs: 100,
        });
        expect(recovered.retryCount).toBeGreaterThanOrEqual(1);
        expect(recovered.externalPostUrn).toBeTruthy();

        // 4. Disable simulation and confirm clean publish with retryCount 0
        await ensureSimulateFailure(client, false);
        const cleanPostRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('W2 Clean Post'),
          scheduledFor: futureIso(150),
        });
        expect(cleanPostRes.status).toBe(201);

        const cleanPublished = await waitForPostStatus(client, cleanPostRes.data.post.id, [
          'published',
        ]);
        expect(cleanPublished.retryCount).toBe(0);
        expect(cleanPublished.lastError).toBeNull();
      });

      it('W3: Concurrent multi-tenant evaluators (independent creds, identical schedules, A cancels while B publishes)', async () => {
        const tenantA = createSessionClient(baseUrl);
        const tenantB = createSessionClient(baseUrl);

        await Promise.all([connectMockTenant(tenantA), connectMockTenant(tenantB)]);

        await Promise.all([
          tenantA.post('/api/account/credentials', {
            clientId: `w3-a-${crypto.randomUUID()}`,
            clientSecret: `w3-sec-a-${crypto.randomUUID()}`,
          }),
          tenantB.post('/api/account/credentials', {
            clientId: `w3-b-${crypto.randomUUID()}`,
            clientSecret: `w3-sec-b-${crypto.randomUUID()}`,
          }),
        ]);

        const sharedContent = uniqueContent('W3 Shared Evaluator Post');
        const sharedTime = futureIso(1000);

        const [schedA, schedB] = await Promise.all([
          tenantA.post<ScheduleResponse>('/api/posts/schedule', {
            content: sharedContent,
            scheduledFor: sharedTime,
          }),
          tenantB.post<ScheduleResponse>('/api/posts/schedule', {
            content: sharedContent,
            scheduledFor: sharedTime,
          }),
        ]);

        expect(schedA.status).toBe(201);
        expect(schedB.status).toBe(201);

        // Tenant A cancels its post while Tenant B lets its post publish
        assertPostActionStatus(
          (await tenantA.post(`/api/posts/${schedA.data.post.id}/cancel`, {})).status,
        );

        const publishedB = await waitForPostStatus(clientOrB(tenantB), schedB.data.post.id, [
          'published',
        ]);
        expect(publishedB.status).toBe('published');

        await sleep(400);
        const listA = await tenantA.get<PostsListResponse>('/api/posts');
        const listB = await tenantB.get<PostsListResponse>('/api/posts');
        expect(listB.data.posts.some((p) => p.id === schedA.data.post.id)).toBe(false);
        expect(listA.data.posts.some((p) => p.id === schedB.data.post.id)).toBe(false);
      });

      it('W4: Custom credentials + OAuth denial recovery + publish + credential cleanup + disconnect preserving history', async () => {
        const client = createSessionClient(baseUrl);
        const customId = `w4-cid-${crypto.randomUUID()}`;
        const customSecret = `w4-secret-${crypto.randomUUID()}`;

        // 1. Save custom OAuth credentials and verify zero secret leak
        const saveRes = await client.post('/api/account/credentials', {
          clientId: customId,
          clientSecret: customSecret,
        });
        assertPostActionStatus(saveRes.status);
        assertNoSecretsInText(saveRes.text, [customId, customSecret]);

        // 2. Simulate user denying OAuth consent (?error=access_denied)
        const deniedRes = await client.get(
          '/api/auth/linkedin/callback?error=access_denied&error_description=User%20denied',
        );
        expect(deniedRes.status).toBeGreaterThanOrEqual(300);
        expect(deniedRes.status).toBeLessThan(400);
        const deniedLoc = new URL(deniedRes.location!, baseUrl);
        expect(deniedLoc.searchParams.get('auth')).toBe('error');

        const accAfterDeny = await client.get<AccountResponse>('/api/account');
        expect(accAfterDeny.data.connected).toBe(false);
        expect(accAfterDeny.data.hasCustomCredentials).toBe(true);

        // 3. Recover via fresh OAuth flow and publish a post
        await connectMockTenant(client);
        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('W4 Recovered Publish'),
          scheduledFor: futureIso(150),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;
        await waitForPostStatus(client, postId, ['published']);

        // 4. Delete custom credentials and disconnect account; history remains intact
        expect((await client.del('/api/account/credentials')).status).toBe(200);
        assertPostActionStatus((await client.post('/api/account/disconnect', {})).status);

        const finalAcc = await client.get<AccountResponse>('/api/account');
        expect(finalAcc.data.connected).toBe(false);
        expect(finalAcc.data.hasCustomCredentials).toBe(false);
        assertNoSecretsInText(finalAcc.text, [customId, customSecret]);

        const finalPosts = await client.get<PostsListResponse>('/api/posts');
        expect(finalPosts.data.posts.some((p) => p.id === postId && p.status === 'published')).toBe(
          true,
        );
      });

      it('W5: Mixed queue lifecycle (published, cancelled, failed via disconnect, 409, invalid cancel, disconnected schedule, healthy end state)', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        // P1: Publish normally
        const p1Content = uniqueContent('W5 P1 Publish');
        const p1Time = futureIso(150);
        const p1Res = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: p1Content,
          scheduledFor: p1Time,
        });
        expect(p1Res.status).toBe(201);
        const p1Id = p1Res.data.post.id;

        // Duplicate 409 check on P1
        const p1Dup = await client.post('/api/posts/schedule', {
          content: p1Content,
          scheduledFor: p1Time,
        });
        expect(p1Dup.status).toBe(409);

        await waitForPostStatus(client, p1Id, ['published']);

        // Invalid cancel on published P1 -> 400
        expect((await client.post(`/api/posts/${p1Id}/cancel`, {})).status).toBe(400);

        // P2: Schedule far in future & cancel
        const p2Res = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('W5 P2 Cancel'),
          scheduledFor: futureIso(120_000),
        });
        expect(p2Res.status).toBe(201);
        const p2Id = p2Res.data.post.id;
        assertPostActionStatus((await client.post(`/api/posts/${p2Id}/cancel`, {})).status);

        // P3: Schedule +2500ms then disconnect -> fails permanently
        const p3Res = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('W5 P3 Disconnect Fail'),
          scheduledFor: futureIso(2500),
        });
        expect(p3Res.status).toBe(201);
        const p3Id = p3Res.data.post.id;

        assertPostActionStatus((await client.post('/api/account/disconnect', {})).status);

        // Schedule while disconnected -> 400
        expect(
          (
            await client.post('/api/posts/schedule', {
              content: uniqueContent('W5 Disconnected'),
              scheduledFor: futureIso(60_000),
            })
          ).status,
        ).toBe(400);

        const failedP3 = await waitForPostStatus(client, p3Id, ['failed'], {
          timeoutMs: 15_000,
          intervalMs: 150,
        });
        expect(failedP3.status).toBe('failed');
        expect(failedP3.retryCount).toBe(0);

        // Final health check
        const finalHealth = await client.get<HealthResponse>('/api/health');
        expect(finalHealth.status).toBe(200);
        expect(finalHealth.data.status).toBe('ok');
      });
    });
  },
);

function clientOrB<T>(client: T): T {
  return client;
}

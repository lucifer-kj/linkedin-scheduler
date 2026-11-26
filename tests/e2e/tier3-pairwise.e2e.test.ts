import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertAuthErrorOutcome,
  assertPostActionStatus,
  connectMockTenant,
  ensureSimulateFailure,
  futureIso,
  isValidSidFormat,
  pastIso,
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
  'Tier 3: Pairwise Cross-Feature Combination Tests',
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

    describe('Pairwise Feature Matrix', { concurrent: false }, () => {
      it('P1 (FA2 x FA3): Cross-tenant OAuth state hijack is blocked while legitimate tenant connects', async () => {
        const tenantA = createSessionClient(baseUrl);
        const tenantB = createSessionClient(baseUrl);

        const urlRes = await tenantA.get<{ url: string }>('/api/auth/linkedin/url');
        expect(urlRes.status).toBe(200);
        const authUrl = new URL(urlRes.data.url, baseUrl);

        // Tenant B tries to redeem Tenant A's state
        await tenantB.get('/api/account');
        const hijackRes = await tenantB.get(`${authUrl.pathname}${authUrl.search}`);
        assertAuthErrorOutcome(hijackRes, baseUrl);

        const accB = await tenantB.get<AccountResponse>('/api/account');
        expect(accB.data.connected).toBe(false);

        // Tenant A redeems its own state legitimately
        const legRes = await tenantA.get(`${authUrl.pathname}${authUrl.search}`);
        expect(legRes.status).toBeGreaterThanOrEqual(300);
        expect(legRes.status).toBeLessThan(400);
        expect(new URL(legRes.location!, baseUrl).searchParams.get('auth')).toBe('success');

        const accA = await tenantA.get<AccountResponse>('/api/account');
        expect(accA.data.connected).toBe(true);
      });

      it('P2 (FA2 x FA4): Independent custom credentials and disconnect isolation across two tenants', async () => {
        const tenantA = createSessionClient(baseUrl);
        const tenantB = createSessionClient(baseUrl);

        await connectMockTenant(tenantA);
        await connectMockTenant(tenantB);

        assertPostActionStatus(
          (
            await tenantA.post('/api/account/credentials', {
              clientId: `cid-a-${crypto.randomUUID()}`,
              clientSecret: `sec-a-${crypto.randomUUID()}`,
            })
          ).status,
        );

        assertPostActionStatus(
          (
            await tenantB.post('/api/account/credentials', {
              clientId: `cid-b-${crypto.randomUUID()}`,
              clientSecret: `sec-b-${crypto.randomUUID()}`,
            })
          ).status,
        );

        // Tenant A deletes creds and disconnects
        expect((await tenantA.del('/api/account/credentials')).status).toBe(200);
        assertPostActionStatus((await tenantA.post('/api/account/disconnect', {})).status);

        const accA = await tenantA.get<AccountResponse>('/api/account');
        expect(accA.data.connected).toBe(false);
        expect(accA.data.hasCustomCredentials).toBe(false);

        const accB = await tenantB.get<AccountResponse>('/api/account');
        expect(accB.data.connected).toBe(true);
        expect(accB.data.hasCustomCredentials).toBe(true);
      });

      it('P3 (FA2 x FA5): Identical (content, scheduledFor) succeeds 201 for Tenant A and Tenant B separately, while Tenant A repeat returns 409', async () => {
        const tenantA = createSessionClient(baseUrl);
        const tenantB = createSessionClient(baseUrl);

        await connectMockTenant(tenantA);
        await connectMockTenant(tenantB);

        const sharedContent = uniqueContent('Pairwise Shared Content');
        const sharedTime = futureIso(120_000);

        const resA1 = await tenantA.post<ScheduleResponse>('/api/posts/schedule', {
          content: sharedContent,
          scheduledFor: sharedTime,
        });
        expect(resA1.status).toBe(201);

        const resB1 = await tenantB.post<ScheduleResponse>('/api/posts/schedule', {
          content: sharedContent,
          scheduledFor: sharedTime,
        });
        expect(resB1.status).toBe(201);
        expect(resA1.data.post.id).not.toBe(resB1.data.post.id);

        const resA2 = await tenantA.post('/api/posts/schedule', {
          content: sharedContent,
          scheduledFor: sharedTime,
        });
        expect(resA2.status).toBe(409);
      });

      it('P4 (FA4 x FA5): Connect -> publish -> disconnect (history preserved) -> schedule fails 400 -> reconnect -> new schedule succeeds 201', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const firstRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P4 Before Disconnect'),
          scheduledFor: futureIso(150),
        });
        expect(firstRes.status).toBe(201);
        const firstId = firstRes.data.post.id;
        await waitForPostStatus(client, firstId, ['published']);

        assertPostActionStatus((await client.post('/api/account/disconnect', {})).status);

        const blockedRes = await client.post('/api/posts/schedule', {
          content: uniqueContent('P4 While Disconnected'),
          scheduledFor: futureIso(60_000),
        });
        expect(blockedRes.status).toBe(400);

        await connectMockTenant(client);
        const secondRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P4 After Reconnect'),
          scheduledFor: futureIso(60_000),
        });
        expect(secondRes.status).toBe(201);

        const listRes = await client.get<PostsListResponse>('/api/posts');
        expect(listRes.data.posts.some((p) => p.id === firstId && p.status === 'published')).toBe(
          true,
        );
        expect(listRes.data.posts.some((p) => p.id === secondRes.data.post.id)).toBe(true);
      });

      it('P5 (FA5 x FA6): Schedule 2 posts -> cancel P1 -> P2 publishes normally while P1 never publishes', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const p1Res = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P5 Cancelled Post'),
          scheduledFor: futureIso(1200),
        });
        const p2Res = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P5 Surviving Post'),
          scheduledFor: futureIso(800),
        });
        expect(p1Res.status).toBe(201);
        expect(p2Res.status).toBe(201);

        const p1Id = p1Res.data.post.id;
        const p2Id = p2Res.data.post.id;

        assertPostActionStatus((await client.post(`/api/posts/${p1Id}/cancel`, {})).status);

        const publishedP2 = await waitForPostStatus(client, p2Id, ['published']);
        expect(publishedP2.status).toBe('published');

        await sleep(800);
        const listRes = await client.get<PostsListResponse>('/api/posts');
        const p1 = listRes.data.posts.find((p) => p.id === p1Id);
        expect(!p1 || (p1.status !== 'published' && p1.externalPostUrn === null)).toBe(true);
      });

      it('P6 (FA1 x FA6): Overdue due post + /api/health sweep transitions to published without duplicate execution', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P6 Overdue Health Sweep'),
          scheduledFor: pastIso(500),
        });
        expect(schedRes.status).toBe(201);
        const postId = schedRes.data.post.id;

        const h1 = await client.get<HealthResponse>('/api/health');
        expect(h1.status).toBe(200);

        const published = await waitForPostStatus(client, postId, ['published']);
        const urn = published.externalPostUrn;
        expect(urn).toBeTruthy();

        const h2 = await client.get<HealthResponse>('/api/health');
        expect(h2.status).toBe(200);
        expect(h2.data.recoveredCount).toBe(0);

        const listRes = await client.get<PostsListResponse>('/api/posts');
        const matches = listRes.data.posts.filter((p) => p.id === postId);
        expect(matches).toHaveLength(1);
        expect(matches[0].externalPostUrn).toBe(urn);
      });

      it('P7 (FA3 x FA7): Fresh mock OAuth connection + 503 simulation ON retries and publishes', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);
        await ensureSimulateFailure(client, true);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P7 OAuth Plus 503 Retry'),
          scheduledFor: futureIso(150),
        });
        expect(schedRes.status).toBe(201);

        const published = await waitForPostStatus(client, schedRes.data.post.id, ['published'], {
          timeoutMs: 18_000,
          intervalMs: 100,
        });
        expect(published.status).toBe('published');
        expect(published.retryCount).toBeGreaterThanOrEqual(1);
        expect(published.externalPostUrn).toBeTruthy();
      });

      it('P8 (FA4 x FA7): Schedule +2500ms -> disconnect before execution -> permanent UnrecoverableError (failed, retryCount 0)', async () => {
        const client = createSessionClient(baseUrl);
        await connectMockTenant(client);

        const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
          content: uniqueContent('P8 Disconnect Unrecoverable'),
          scheduledFor: futureIso(2500),
        });
        expect(schedRes.status).toBe(201);

        assertPostActionStatus((await client.post('/api/account/disconnect', {})).status);

        const failed = await waitForPostStatus(client, schedRes.data.post.id, ['failed'], {
          timeoutMs: 15_000,
          intervalMs: 150,
        });
        expect(failed.status).toBe('failed');
        expect(failed.retryCount).toBe(0);
        expect(failed.lastError).toBeTruthy();
      });

      it('P9 (FA2 x FA8): Static HTML serving / + isolated tenant API cookies + /api/* 404 exclusion', async () => {
        const tenantA = createSessionClient(baseUrl);
        const tenantB = createSessionClient(baseUrl);

        const htmlRes = await tenantA.get('/');
        expect(htmlRes.status).toBe(200);
        expect(isValidHtmlDocument(htmlRes.text)).toBe(true);

        const accA = await tenantA.get<AccountResponse>('/api/account');
        const accB = await tenantB.get<AccountResponse>('/api/account');
        expect(accA.status).toBe(200);
        expect(accB.status).toBe(200);
        expect(isValidSidFormat(tenantA.getCookie('li_scheduler_sid') ?? '')).toBe(true);
        expect(isValidSidFormat(tenantB.getCookie('li_scheduler_sid') ?? '')).toBe(true);
        expect(tenantA.getCookie('li_scheduler_sid')).not.toBe(tenantB.getCookie('li_scheduler_sid'));

        const missingApi = await tenantA.get('/api/unknown-endpoint-check');
        expect(missingApi.status).toBe(404);
        expect(missingApi.contentType.toLowerCase()).not.toContain('text/html');
      });
    });
  },
);

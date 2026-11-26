import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertErrorBody,
  assertPostActionStatus,
  connectMockTenant,
  futureIso,
  sleep,
  uniqueContent,
  waitForPostStatus,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA6: Queue Statuses, CAS Claim Observability & Cancellation',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: Future post (+120s) stays scheduled with null externalPostUrn and null publishedAt', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Future Post'),
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      await sleep(300);
      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const found = listRes.data.posts.find((p) => p.id === postId);
      expect(found).toBeDefined();
      expect(found!.status).toBe('scheduled');
      expect(found!.externalPostUrn).toBeNull();
      expect(found!.publishedAt).toBeNull();
    });

    it('T1.2: Immediate due post transitions to published with externalPostUrn and publishedAt', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Immediate Publish'),
        scheduledFor: futureIso(200),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const published = await waitForPostStatus(client, postId, ['published']);
      expect(published.status).toBe('published');
      expect(published.externalPostUrn).toBeTruthy();
      expect(published.publishedAt).toBeTruthy();
      expect(Number.isNaN(Date.parse(published.publishedAt!))).toBe(false);
    });

    it('T1.3: Multiple posts in GET /api/posts are ordered createdAt descending', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const p1 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Order First'),
        scheduledFor: futureIso(120_000),
      });
      expect(p1.status).toBe(201);

      await sleep(25);
      const p2 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Order Second'),
        scheduledFor: futureIso(125_000),
      });
      expect(p2.status).toBe(201);

      await sleep(25);
      const p3 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Order Third'),
        scheduledFor: futureIso(130_000),
      });
      expect(p3.status).toBe(201);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const ids = listRes.data.posts.map((p) => p.id);
      const idx3 = ids.indexOf(p3.data.post.id);
      const idx2 = ids.indexOf(p2.data.post.id);
      const idx1 = ids.indexOf(p1.data.post.id);
      expect(idx3).toBeGreaterThanOrEqual(0);
      expect(idx2).toBeGreaterThan(idx3);
      expect(idx1).toBeGreaterThan(idx2);
    });

    it('T1.4: POST /api/posts/:id/cancel cancels or removes a scheduled post', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Cancel Me'),
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const cancelRes = await client.post(`/api/posts/${postId}/cancel`, {});
      assertPostActionStatus(cancelRes.status);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const found = listRes.data.posts.find((p) => p.id === postId);
      expect(!found || found.status === 'cancelled' || found.status === 'canceled').toBe(true);
    });

    it('T1.5: Cancelled post does not publish after its scheduledFor timestamp passes', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Cancelled Never Publishes'),
        scheduledFor: futureIso(1200),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const cancelRes = await client.post(`/api/posts/${postId}/cancel`, {});
      assertPostActionStatus(cancelRes.status);

      await sleep(1800);
      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const found = listRes.data.posts.find((p) => p.id === postId);
      if (found) {
        expect(found.status).not.toBe('published');
        expect(found.externalPostUrn).toBeNull();
      }
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: Cancelling a non-existent UUID returns 404', async () => {
      const client = createSessionClient(baseUrl);
      await client.get('/api/account');

      const missingId = crypto.randomUUID();
      const res = await client.post(`/api/posts/${missingId}/cancel`, {});
      expect(res.status).toBe(404);
      assertErrorBody(res.data);
    });

    it('T2.2: Cancelling an already-published post returns 400', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Published Cancel Reject'),
        scheduledFor: futureIso(150),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      await waitForPostStatus(client, postId, ['published']);

      const cancelRes = await client.post(`/api/posts/${postId}/cancel`, {});
      expect(cancelRes.status).toBe(400);
      assertErrorBody(cancelRes.data);
    });

    it('T2.3: Cancelling the same scheduled post twice fails on the second call (404 or 400)', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Double Cancel'),
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const firstCancel = await client.post(`/api/posts/${postId}/cancel`, {});
      assertPostActionStatus(firstCancel.status);

      const secondCancel = await client.post(`/api/posts/${postId}/cancel`, {});
      expect([400, 404]).toContain(secondCancel.status);
    });

    it('T2.4: 5 concurrent identical POST /api/posts/schedule requests yield 1x 201 and 4x 409', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA6 Concurrent Burst');
      const scheduledFor = futureIso(120_000);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          client.post('/api/posts/schedule', { content, scheduledFor }),
        ),
      );

      const statuses = results.map((r) => r.status).sort((a, b) => a - b);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(4);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.data.posts.filter((p) => p.content === content)).toHaveLength(1);
    });

    it('T2.5: Immediate post publishes at most once with a single stable externalPostUrn across repeated polls', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA6 Single CAS Publish'),
        scheduledFor: futureIso(150),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const firstObserved = await waitForPostStatus(client, postId, ['published']);
      await sleep(500);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      const matches = listRes.data.posts.filter((p) => p.id === postId);
      expect(matches).toHaveLength(1);
      expect(matches[0].status).toBe('published');
      expect(matches[0].externalPostUrn).toBe(firstObserved.externalPostUrn);
      expect(matches[0].publishedAt).toBe(firstObserved.publishedAt);
    });
  },
);

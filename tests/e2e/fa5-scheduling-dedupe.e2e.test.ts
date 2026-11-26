import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertErrorBody,
  connectMockTenant,
  futureIso,
  uniqueContent,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA5: Post Scheduling & SHA-256 Deduplication',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: POST /api/posts/schedule returns 201 with scheduled post, retryCount 0, maxRetries 5', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA5 Valid Schedule');
      const scheduledFor = futureIso(120_000);
      const res = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor,
      });

      expect(res.status).toBe(201);
      expect(res.data.post).toBeDefined();
      expect(res.data.post.id).toBeTruthy();
      expect(res.data.post.content).toBe(content);
      expect(res.data.post.status).toBe('scheduled');
      expect(res.data.post.retryCount).toBe(0);
      expect(res.data.post.maxRetries).toBe(5);
    });

    it('T1.2: Scheduled post appears in GET /api/posts with 64-char hex idempotencyKey', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA5 Idempotency Key');
      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const found = listRes.data.posts.find((p) => p.id === schedRes.data.post.id);
      expect(found).toBeDefined();
      expect(found!.idempotencyKey).toMatch(/^[0-9a-f]{64}$/i);
    });

    it('T1.3: Same content with different scheduledFor succeeds (201) and creates two distinct posts', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA5 Same Content Different Time');
      const res1 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(120_000),
      });
      const res2 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(180_000),
      });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.data.post.id).not.toBe(res2.data.post.id);
      expect(res1.data.post.idempotencyKey).not.toBe(res2.data.post.idempotencyKey);
    });

    it('T1.4: Same scheduledFor with different content succeeds (201) and creates two distinct posts', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const scheduledFor = futureIso(150_000);
      const res1 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA5 Time Shared A'),
        scheduledFor,
      });
      const res2 = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: uniqueContent('FA5 Time Shared B'),
        scheduledFor,
      });

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.data.post.id).not.toBe(res2.data.post.id);
      expect(res1.data.post.idempotencyKey).not.toBe(res2.data.post.idempotencyKey);
    });

    it('T1.5: Exact 3000-character content succeeds with 201', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const prefix = `${uniqueContent('FA5-3000')} `;
      const exact3000 = prefix + 'x'.repeat(3000 - prefix.length);
      expect(exact3000).toHaveLength(3000);

      const res = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content: exact3000,
        scheduledFor: futureIso(120_000),
      });

      expect(res.status).toBe(201);
      expect(res.data.post.content).toHaveLength(3000);
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: Scheduling when LinkedIn account is not connected returns 400', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.post('/api/posts/schedule', {
        content: uniqueContent('FA5 Unconnected'),
        scheduledFor: futureIso(60_000),
      });

      expect(res.status).toBe(400);
      assertErrorBody(res.data);
    });

    it('T2.2: Empty or whitespace-only content returns 400', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const emptyRes = await client.post('/api/posts/schedule', {
        content: '',
        scheduledFor: futureIso(60_000),
      });
      expect(emptyRes.status).toBe(400);
      assertErrorBody(emptyRes.data);

      const spaceRes = await client.post('/api/posts/schedule', {
        content: '   \n\t  ',
        scheduledFor: futureIso(60_000),
      });
      expect(spaceRes.status).toBe(400);
      assertErrorBody(spaceRes.data);
    });

    it('T2.3: 3001-character content returns 400', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const overLimit = 'a'.repeat(3001);
      const res = await client.post('/api/posts/schedule', {
        content: overLimit,
        scheduledFor: futureIso(60_000),
      });

      expect(res.status).toBe(400);
      assertErrorBody(res.data);
    });

    it('T2.4: Invalid or missing scheduledFor returns 400', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const invalidDateRes = await client.post('/api/posts/schedule', {
        content: uniqueContent('FA5 Bad Date'),
        scheduledFor: 'not-a-valid-date',
      });
      expect(invalidDateRes.status).toBe(400);
      assertErrorBody(invalidDateRes.data);

      const missingDateRes = await client.post('/api/posts/schedule', {
        content: uniqueContent('FA5 Missing Date'),
      });
      expect(missingDateRes.status).toBe(400);
      assertErrorBody(missingDateRes.data);
    });

    it('T2.5: Duplicate (content, scheduledFor) including trimmed whitespace and equivalent UTC offset returns 409', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA5 Dedupe Check');
      const isoUtc = futureIso(120_000);
      const isoPlusZero = isoUtc.replace('Z', '+00:00');

      const firstRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: isoUtc,
      });
      expect(firstRes.status).toBe(201);

      const dupExact = await client.post('/api/posts/schedule', {
        content,
        scheduledFor: isoUtc,
      });
      expect(dupExact.status).toBe(409);

      const dupTrimAndOffset = await client.post('/api/posts/schedule', {
        content: `  ${content}  `,
        scheduledFor: isoPlusZero,
      });
      expect(dupTrimAndOffset.status).toBe(409);

      const listRes = await client.get<PostsListResponse>('/api/posts');
      expect(listRes.status).toBe(200);
      const matching = listRes.data.posts.filter((p) => p.content === content);
      expect(matching).toHaveLength(1);
    });
  },
);

import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertErrorBody,
  assertNoSecretsInText,
  assertPostActionStatus,
  connectMockTenant,
  futureIso,
  uniqueContent,
  waitForPostStatus,
  type AccountResponse,
  type HealthResponse,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA4: Custom OAuth Credentials, Disconnect & Token Expiry',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: Fresh tenant GET /api/account reports hasCustomCredentials false, connected false, isExpired false', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<AccountResponse>('/api/account');

      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      expect(res.data.isExpired).toBe(false);
      expect(res.data.hasCustomCredentials).toBe(false);
      expect(['mock', 'live']).toContain(res.data.mode);
      expect(res.data.account).toBeNull();
    });

    it('T1.2: POST /api/account/credentials saves credentials and sets hasCustomCredentials true', async () => {
      const client = createSessionClient(baseUrl);
      const saveRes = await client.post<{ ok?: boolean; hasCustomCredentials?: boolean }>(
        '/api/account/credentials',
        {
          clientId: `custom-id-${crypto.randomUUID()}`,
          clientSecret: `custom-secret-${crypto.randomUUID()}`,
        },
      );

      assertPostActionStatus(saveRes.status);
      expect(saveRes.data.hasCustomCredentials).toBe(true);

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.status).toBe(200);
      expect(accountRes.data.hasCustomCredentials).toBe(true);
    });

    it('T1.3: Second POST /api/account/credentials updates credentials cleanly (upsert)', async () => {
      const client = createSessionClient(baseUrl);
      const res1 = await client.post('/api/account/credentials', {
        clientId: `id-v1-${crypto.randomUUID()}`,
        clientSecret: `sec-v1-${crypto.randomUUID()}`,
      });
      assertPostActionStatus(res1.status);

      const res2 = await client.post<{ hasCustomCredentials?: boolean }>(
        '/api/account/credentials',
        {
          clientId: `id-v2-${crypto.randomUUID()}`,
          clientSecret: `sec-v2-${crypto.randomUUID()}`,
        },
      );
      assertPostActionStatus(res2.status);
      expect(res2.data.hasCustomCredentials).toBe(true);

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.data.hasCustomCredentials).toBe(true);
    });

    it('T1.4: DELETE /api/account/credentials resets hasCustomCredentials false', async () => {
      const client = createSessionClient(baseUrl);
      const saveRes = await client.post('/api/account/credentials', {
        clientId: `id-del-${crypto.randomUUID()}`,
        clientSecret: `sec-del-${crypto.randomUUID()}`,
      });
      assertPostActionStatus(saveRes.status);

      const delRes = await client.del<{ ok?: boolean; hasCustomCredentials?: boolean }>(
        '/api/account/credentials',
      );
      expect(delRes.status).toBe(200);
      expect(delRes.data.hasCustomCredentials).toBe(false);

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.status).toBe(200);
      expect(accountRes.data.hasCustomCredentials).toBe(false);
    });

    it('T1.5: POST /api/account/disconnect sets connected false while preserving post history in GET /api/posts', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);

      const content = uniqueContent('FA4 History Preserved');
      const schedRes = await client.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(200),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      await waitForPostStatus(client, postId, ['published']);

      const discRes = await client.post<{ ok?: boolean; connected?: boolean }>(
        '/api/account/disconnect',
        {},
      );
      assertPostActionStatus(discRes.status);
      expect(discRes.data.connected).toBe(false);

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.data.connected).toBe(false);
      expect(accountRes.data.account).toBeNull();

      const postsRes = await client.get<PostsListResponse>('/api/posts');
      expect(postsRes.status).toBe(200);
      const found = postsRes.data.posts.find((p) => p.id === postId);
      expect(found).toBeDefined();
      expect(found!.content).toBe(content);
      expect(found!.status).toBe('published');
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: POST /api/account/credentials with empty or whitespace-only fields returns 400', async () => {
      const client = createSessionClient(baseUrl);

      const resEmpty = await client.post('/api/account/credentials', {
        clientId: '',
        clientSecret: '',
      });
      expect(resEmpty.status).toBe(400);
      assertErrorBody(resEmpty.data);

      const resWhitespace = await client.post('/api/account/credentials', {
        clientId: '   ',
        clientSecret: 'valid-secret',
      });
      expect(resWhitespace.status).toBe(400);
      assertErrorBody(resWhitespace.data);
    });

    it('T2.2: POST /api/account/credentials missing required field returns 400', async () => {
      const client = createSessionClient(baseUrl);

      const resMissingSecret = await client.post('/api/account/credentials', {
        clientId: 'only-client-id',
      });
      expect(resMissingSecret.status).toBe(400);
      assertErrorBody(resMissingSecret.data);

      const resMissingId = await client.post('/api/account/credentials', {
        clientSecret: 'only-client-secret',
      });
      expect(resMissingId.status).toBe(400);
      assertErrorBody(resMissingId.data);
    });

    it('T2.3: Secret non-disclosure: clientSecret, clientId, and encrypted token fields never appear in any API response', async () => {
      const client = createSessionClient(baseUrl);
      const customId = `secret-cid-${crypto.randomUUID()}`;
      const customSecret = `super-secret-${crypto.randomUUID()}`;

      const saveRes = await client.post('/api/account/credentials', {
        clientId: customId,
        clientSecret: customSecret,
      });
      assertPostActionStatus(saveRes.status);
      assertNoSecretsInText(saveRes.text, [customId, customSecret]);

      await connectMockTenant(client);
      const accountRes = await client.get<AccountResponse>('/api/account');
      assertNoSecretsInText(accountRes.text, [customId, customSecret]);

      const postsRes = await client.get<PostsListResponse>('/api/posts');
      assertNoSecretsInText(postsRes.text, [customId, customSecret]);

      const healthRes = await client.get<HealthResponse>('/api/health');
      assertNoSecretsInText(healthRes.text, [customId, customSecret]);
    });

    it('T2.4: DELETE /api/account/credentials when none saved returns 200 or 404 without 500', async () => {
      const client = createSessionClient(baseUrl);
      const delRes = await client.del('/api/account/credentials');

      expect([200, 404]).toContain(delRes.status);
      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.status).toBe(200);
      expect(accountRes.data.hasCustomCredentials).toBe(false);
    });

    it('T2.5: POST /api/account/disconnect when already disconnected succeeds cleanly and scheduling returns 400', async () => {
      const client = createSessionClient(baseUrl);
      const discRes = await client.post('/api/account/disconnect', {});
      assertPostActionStatus(discRes.status);

      const schedRes = await client.post('/api/posts/schedule', {
        content: uniqueContent('Disconnected Schedule'),
        scheduledFor: futureIso(60_000),
      });
      expect(schedRes.status).toBe(400);
      assertErrorBody(schedRes.data);
    });
  },
);

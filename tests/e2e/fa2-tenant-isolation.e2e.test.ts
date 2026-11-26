import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertPostActionStatus,
  connectMockTenant,
  futureIso,
  isValidSidFormat,
  uniqueContent,
  type AccountResponse,
  type PostsListResponse,
  type ScheduleResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA2: Multi-Tenant Session Cookie Isolation',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: First /api/account request issues li_scheduler_sid cookie with HttpOnly, SameSite=Lax, Path=/, and <uuid>.<hex> format', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<AccountResponse>('/api/account');

      expect(res.status).toBe(200);
      const sidCookie = res.setCookies.find((c) => c.name === 'li_scheduler_sid');
      expect(sidCookie).toBeDefined();
      expect(sidCookie!.httpOnly).toBe(true);
      expect((sidCookie!.sameSite ?? '').toLowerCase()).toBe('lax');
      expect(sidCookie!.path).toBe('/');
      expect(isValidSidFormat(sidCookie!.value)).toBe(true);
    });

    it('T1.2: Resending valid li_scheduler_sid preserves tenant identity without rotating session', async () => {
      const client = createSessionClient(baseUrl);
      await connectMockTenant(client);
      const originalSid = client.getCookie('li_scheduler_sid');
      expect(originalSid).toBeTruthy();

      const res = await client.get<AccountResponse>('/api/account');
      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(true);

      const reissued = res.setCookies.find((c) => c.name === 'li_scheduler_sid');
      if (reissued) {
        expect(reissued.value).toBe(originalSid);
      }
    });

    it('T1.3: Distinct clients without cookies receive distinct li_scheduler_sid session cookies', async () => {
      const clientA = createSessionClient(baseUrl);
      const clientB = createSessionClient(baseUrl);

      const resA = await clientA.get<AccountResponse>('/api/account');
      const resB = await clientB.get<AccountResponse>('/api/account');

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const sidA = clientA.getCookie('li_scheduler_sid');
      const sidB = clientB.getCookie('li_scheduler_sid');
      expect(sidA).toBeTruthy();
      expect(sidB).toBeTruthy();
      expect(sidA).not.toBe(sidB);
    });

    it('T1.4: Tenant A OAuth connect does not connect Tenant B', async () => {
      const tenantA = createSessionClient(baseUrl);
      const tenantB = createSessionClient(baseUrl);

      await connectMockTenant(tenantA);

      const accountB = await tenantB.get<AccountResponse>('/api/account');
      expect(accountB.status).toBe(200);
      expect(accountB.data.connected).toBe(false);
      expect(accountB.data.account).toBeNull();
    });

    it('T1.5: Tenant A scheduled posts do not appear in Tenant B GET /api/posts', async () => {
      const tenantA = createSessionClient(baseUrl);
      const tenantB = createSessionClient(baseUrl);

      await connectMockTenant(tenantA);
      await connectMockTenant(tenantB);

      const secretPostA = uniqueContent('TenantA Private Post');
      const schedRes = await tenantA.post<ScheduleResponse>('/api/posts/schedule', {
        content: secretPostA,
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);

      const listB = await tenantB.get<PostsListResponse>('/api/posts');
      expect(listB.status).toBe(200);
      expect(listB.data.posts.some((p) => p.content === secretPostA)).toBe(false);

      const listA = await tenantA.get<PostsListResponse>('/api/posts');
      expect(listA.status).toBe(200);
      expect(listA.data.posts.some((p) => p.content === secretPostA)).toBe(true);
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: Tampered HMAC signature cookie is rejected and replaced with a fresh isolated tenant', async () => {
      const tenantA = createSessionClient(baseUrl);
      await connectMockTenant(tenantA);
      const validSid = tenantA.getCookie('li_scheduler_sid')!;
      const lastChar = validSid.slice(-1);
      const flippedChar = lastChar === '0' ? '1' : '0';
      const tamperedSid = `${validSid.slice(0, -1)}${flippedChar}`;

      const attacker = createSessionClient(baseUrl);
      const res = await attacker.get<AccountResponse>('/api/account', {
        rawCookie: `li_scheduler_sid=${tamperedSid}`,
      });

      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      expect(res.data.account).toBeNull();
      const newSid = res.setCookies.find((c) => c.name === 'li_scheduler_sid');
      expect(newSid).toBeDefined();
      expect(newSid!.value).not.toBe(validSid);
      expect(newSid!.value).not.toBe(tamperedSid);
      expect(isValidSidFormat(newSid!.value)).toBe(true);
    });

    it('T2.2: Malformed cookie values (nodot, empty, SQLi payload) never 500 and issue valid session cookies', async () => {
      const malformedValues = [
        'li_scheduler_sid=nodothere',
        'li_scheduler_sid=',
        "li_scheduler_sid=' OR 1=1--; SELECT * FROM users",
      ];

      for (const rawCookie of malformedValues) {
        const client = createSessionClient(baseUrl);
        const res = await client.get<AccountResponse>('/api/account', { rawCookie });
        expect(res.status).toBe(200);
        expect(res.data.connected).toBe(false);
        const newSid = res.setCookies.find((c) => c.name === 'li_scheduler_sid');
        expect(newSid).toBeDefined();
        expect(isValidSidFormat(newSid!.value)).toBe(true);
      }
    });

    it('T2.3: Valid UUID with wrong 64-hex HMAC signature is rejected and isolated from original tenant', async () => {
      const tenantA = createSessionClient(baseUrl);
      await connectMockTenant(tenantA);
      const validSid = tenantA.getCookie('li_scheduler_sid')!;
      const uuidPart = validSid.split('.')[0];
      const wrongSig = 'a'.repeat(64);
      const forgedSid = `${uuidPart}.${wrongSig === validSid.split('.')[1] ? 'b'.repeat(64) : wrongSig}`;

      const attacker = createSessionClient(baseUrl);
      const res = await attacker.get<AccountResponse>('/api/account', {
        rawCookie: `li_scheduler_sid=${forgedSid}`,
      });

      expect(res.status).toBe(200);
      expect(res.data.connected).toBe(false);
      const newSid = res.setCookies.find((c) => c.name === 'li_scheduler_sid');
      expect(newSid).toBeDefined();
      expect(newSid!.value).not.toBe(validSid);
    });

    it('T2.4: Tenant B POST /api/posts/:id/cancel on Tenant A post returns 404 or 403 and leaves post scheduled', async () => {
      const tenantA = createSessionClient(baseUrl);
      const tenantB = createSessionClient(baseUrl);

      await connectMockTenant(tenantA);
      await connectMockTenant(tenantB);

      const content = uniqueContent('FA2 Protected Post');
      const schedRes = await tenantA.post<ScheduleResponse>('/api/posts/schedule', {
        content,
        scheduledFor: futureIso(120_000),
      });
      expect(schedRes.status).toBe(201);
      const postId = schedRes.data.post.id;

      const cancelB = await tenantB.post(`/api/posts/${postId}/cancel`, {});
      expect([403, 404]).toContain(cancelB.status);

      const listA = await tenantA.get<PostsListResponse>('/api/posts');
      expect(listA.status).toBe(200);
      const postA = listA.data.posts.find((p) => p.id === postId);
      expect(postA).toBeDefined();
      expect(postA!.status).toBe('scheduled');
    });

    it('T2.5: Tenant B disconnect and DELETE credentials leave Tenant A connection and credentials untouched', async () => {
      const tenantA = createSessionClient(baseUrl);
      const tenantB = createSessionClient(baseUrl);

      await connectMockTenant(tenantA);
      const credResA = await tenantA.post('/api/account/credentials', {
        clientId: `cid-${crypto.randomUUID()}`,
        clientSecret: `csec-${crypto.randomUUID()}`,
      });
      assertPostActionStatus(credResA.status);

      await connectMockTenant(tenantB);
      const discB = await tenantB.post('/api/account/disconnect', {});
      assertPostActionStatus(discB.status);
      const delCredB = await tenantB.del('/api/account/credentials');
      expect([200, 404]).toContain(delCredB.status);

      const accountA = await tenantA.get<AccountResponse>('/api/account');
      expect(accountA.status).toBe(200);
      expect(accountA.data.connected).toBe(true);
      expect(accountA.data.hasCustomCredentials).toBe(true);
    });
  },
);

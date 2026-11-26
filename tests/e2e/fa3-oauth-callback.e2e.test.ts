import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import {
  assertAuthErrorOutcome,
  connectMockTenant,
  type AccountResponse,
} from './helpers/assertions.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA3: LinkedIn OAuth CSRF state, ?error= & Mock Callback',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: GET /api/auth/linkedin/url returns 200 with url containing non-empty state', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get<{ url: string }>('/api/auth/linkedin/url');

      expect(res.status).toBe(200);
      expect(typeof res.data.url).toBe('string');
      const parsed = new URL(res.data.url, baseUrl);
      const state = parsed.searchParams.get('state') ?? '';
      expect(state.length).toBeGreaterThanOrEqual(8);
      expect(parsed.pathname.endsWith('/api/auth/linkedin/callback') || parsed.hostname.includes('linkedin.com')).toBe(
        true,
      );
    });

    it('T1.2: Two consecutive GET /api/auth/linkedin/url calls produce distinct state values', async () => {
      const client = createSessionClient(baseUrl);
      const res1 = await client.get<{ url: string }>('/api/auth/linkedin/url');
      const res2 = await client.get<{ url: string }>('/api/auth/linkedin/url');

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const state1 = new URL(res1.data.url, baseUrl).searchParams.get('state');
      const state2 = new URL(res2.data.url, baseUrl).searchParams.get('state');
      expect(state1).toBeTruthy();
      expect(state2).toBeTruthy();
      expect(state1).not.toBe(state2);
    });

    it('T1.3: Mock callback with valid state redirects (3xx) to /?auth=success', async () => {
      const client = createSessionClient(baseUrl);
      const { callbackRes } = await connectMockTenant(client);

      expect(callbackRes.status).toBeGreaterThanOrEqual(300);
      expect(callbackRes.status).toBeLessThan(400);
      const locationUrl = new URL(callbackRes.location!, baseUrl);
      expect(locationUrl.pathname).toBe('/');
      expect(locationUrl.searchParams.get('auth')).toBe('success');
    });

    it('T1.4: After callback, GET /api/account reports connected true, isExpired false, and valid account fields', async () => {
      const client = createSessionClient(baseUrl);
      const { accountRes } = await connectMockTenant(client);

      expect(accountRes.data.connected).toBe(true);
      expect(accountRes.data.isExpired).toBe(false);
      expect(accountRes.data.account).not.toBeNull();
      const account = accountRes.data.account!;
      expect(account.id).toBeTruthy();
      expect(account.linkedinName).toBeTruthy();
      expect(account.linkedinPersonUrn).toMatch(/^urn:li:person:/);
      expect(Date.parse(account.expiresAt)).toBeGreaterThan(Date.now());
      expect(Number.isNaN(Date.parse(account.createdAt))).toBe(false);
    });

    it('T1.5: Re-authenticating via new state + callback succeeds and maintains single connected account', async () => {
      const client = createSessionClient(baseUrl);
      const first = await connectMockTenant(client);
      const second = await connectMockTenant(client);

      expect(second.state).not.toBe(first.state);
      expect(second.accountRes.data.connected).toBe(true);
      expect(second.accountRes.data.account).not.toBeNull();
      expect(second.accountRes.data.account!.linkedinPersonUrn).toBeTruthy();
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: Callback with ?error=access_denied&error_description=... redirects to /?auth=error with message and stays disconnected', async () => {
      const client = createSessionClient(baseUrl);
      const urlRes = await client.get<{ url: string }>('/api/auth/linkedin/url');
      expect(urlRes.status).toBe(200);
      const state = new URL(urlRes.data.url, baseUrl).searchParams.get('state')!;

      const callbackRes = await client.get(
        `/api/auth/linkedin/callback?error=access_denied&error_description=${encodeURIComponent(
          'User cancelled authorization',
        )}&state=${encodeURIComponent(state)}`,
      );

      expect(callbackRes.status).toBeGreaterThanOrEqual(300);
      expect(callbackRes.status).toBeLessThan(400);
      expect(callbackRes.location).toBeTruthy();
      const redirectUrl = new URL(callbackRes.location!, baseUrl);
      expect(redirectUrl.searchParams.get('auth')).toBe('error');
      expect(redirectUrl.searchParams.get('message')).toBeTruthy();

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.status).toBe(200);
      expect(accountRes.data.connected).toBe(false);
    });

    it('T2.2: Callback with unknown/forged state fails and leaves tenant disconnected', async () => {
      const client = createSessionClient(baseUrl);
      // Establish tenant session cookie first
      await client.get('/api/account');

      const forgedState = crypto.randomBytes(16).toString('hex');
      const callbackRes = await client.get(
        `/api/auth/linkedin/callback?code=mock_auth_code_12345&state=${forgedState}`,
      );

      assertAuthErrorOutcome(callbackRes, baseUrl);
      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.status).toBe(200);
      expect(accountRes.data.connected).toBe(false);
    });

    it('T2.3: Replaying the same valid state twice fails on second attempt (single-use CSRF state)', async () => {
      const client = createSessionClient(baseUrl);
      const { authUrl } = await connectMockTenant(client);

      const replayRes = await client.get(`${authUrl.pathname}${authUrl.search}`);
      assertAuthErrorOutcome(replayRes, baseUrl);
    });

    it('T2.4: Cross-tenant state redemption (Tenant B uses Tenant A state) fails and leaves Tenant B disconnected', async () => {
      const tenantA = createSessionClient(baseUrl);
      const tenantB = createSessionClient(baseUrl);

      const urlA = await tenantA.get<{ url: string }>('/api/auth/linkedin/url');
      expect(urlA.status).toBe(200);
      const parsedA = new URL(urlA.data.url, baseUrl);

      // Tenant B creates its own session first
      await tenantB.get('/api/account');
      const hijackRes = await tenantB.get(`${parsedA.pathname}${parsedA.search}`);
      assertAuthErrorOutcome(hijackRes, baseUrl);

      const accountB = await tenantB.get<AccountResponse>('/api/account');
      expect(accountB.status).toBe(200);
      expect(accountB.data.connected).toBe(false);
    });

    it('T2.5: Callback missing code (without ?error=) or missing state fails cleanly without 500', async () => {
      const client = createSessionClient(baseUrl);
      const urlRes = await client.get<{ url: string }>('/api/auth/linkedin/url');
      expect(urlRes.status).toBe(200);
      const state = new URL(urlRes.data.url, baseUrl).searchParams.get('state')!;

      const missingCodeRes = await client.get(
        `/api/auth/linkedin/callback?state=${encodeURIComponent(state)}`,
      );
      expect(missingCodeRes.status).not.toBe(500);
      assertAuthErrorOutcome(missingCodeRes, baseUrl);

      const missingStateRes = await client.get('/api/auth/linkedin/callback?code=mock_auth_code_12345');
      expect(missingStateRes.status).not.toBe(500);
      assertAuthErrorOutcome(missingStateRes, baseUrl);

      const accountRes = await client.get<AccountResponse>('/api/account');
      expect(accountRes.data.connected).toBe(false);
    });
  },
);

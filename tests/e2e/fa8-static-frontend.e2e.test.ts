import { beforeAll, describe, expect, it } from 'vitest';
import { createSessionClient, getE2eBaseUrl } from './helpers/http-client.js';
import { assertNoSecretsInText } from './helpers/assertions.js';
import {
  extractHtmlAssets,
  isValidHtmlDocument,
  readLocalDistPublicIndex,
} from './helpers/static-bundle.js';

const BASE_URL = process.env.E2E_BASE_URL?.trim();

describe.skipIf(!BASE_URL)(
  'FA8: Static Frontend Serving (dist/public) & UI Contract',
  { timeout: 25_000 },
  () => {
    let baseUrl: string;

    beforeAll(() => {
      baseUrl = getE2eBaseUrl();
    });

    // Tier 1: Happy Path (5 tests)
    it('T1.1: GET / returns 200 with text/html content-type and valid HTML document', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get('/');

      expect(res.status).toBe(200);
      expect(res.contentType.toLowerCase()).toContain('text/html');
      expect(isValidHtmlDocument(res.text)).toBe(true);
    });

    it('T1.2: GET /?auth=success and GET /?auth=error&message=denied return 200 text/html', async () => {
      const client = createSessionClient(baseUrl);

      const resSuccess = await client.get('/?auth=success');
      expect(resSuccess.status).toBe(200);
      expect(resSuccess.contentType.toLowerCase()).toContain('text/html');
      expect(isValidHtmlDocument(resSuccess.text)).toBe(true);

      const resError = await client.get('/?auth=error&message=denied');
      expect(resError.status).toBe(200);
      expect(resError.contentType.toLowerCase()).toContain('text/html');
      expect(isValidHtmlDocument(resError.text)).toBe(true);
    });

    it('T1.3: Same-origin <script> and <link> assets referenced in served HTML return 200 non-empty', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get('/');
      expect(res.status).toBe(200);

      const assets = extractHtmlAssets(res.text);
      const sameOriginAssets = [...assets.sameOriginScripts, ...assets.sameOriginStyles];

      for (const assetPath of sameOriginAssets) {
        const assetRes = await client.get(assetPath);
        expect(assetRes.status).toBe(200);
        expect(assetRes.text.length).toBeGreaterThan(0);
      }
    });

    it('T1.4: Non-API SPA fallback route (/dashboard) returns 200 text/html', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get('/dashboard');

      expect(res.status).toBe(200);
      expect(res.contentType.toLowerCase()).toContain('text/html');
      expect(isValidHtmlDocument(res.text)).toBe(true);
    });

    it('T1.5: Local dist/public/index.html (when present) is a non-empty valid static HTML export', async () => {
      const localBundle = readLocalDistPublicIndex();
      if (localBundle.exists) {
        expect(localBundle.html).toBeTruthy();
        expect(isValidHtmlDocument(localBundle.html!)).toBe(true);
        assertNoSecretsInText(localBundle.html!);
      } else {
        // When running against a remote target without local dist/public, verify served HTML directly
        const client = createSessionClient(baseUrl);
        const res = await client.get('/');
        expect(res.status).toBe(200);
        expect(isValidHtmlDocument(res.text)).toBe(true);
      }
    });

    // Tier 2: Boundary / Invalid Input / Edge (5 tests)
    it('T2.1: GET /api/does-not-exist returns 404 (not 200 text/html SPA fallback)', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get('/api/does-not-exist');

      expect(res.status).toBe(404);
      expect(res.contentType.toLowerCase()).not.toContain('text/html');
    });

    it('T2.2: POST /api/does-not-exist returns 404 JSON, not HTML', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.post('/api/does-not-exist', { test: true });

      expect(res.status).toBe(404);
      expect(res.contentType.toLowerCase()).not.toContain('text/html');
    });

    it('T2.3: Path traversal probes never leak package.json or server files and never 500', async () => {
      const client = createSessionClient(baseUrl);
      const probes = ['/%2e%2e/package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/.env'];

      for (const probe of probes) {
        const res = await client.get(probe);
        expect(res.status).not.toBe(500);
        expect(res.text).not.toContain('"dependencies"');
        expect(res.text).not.toContain('"devDependencies"');
        expect(res.text).not.toContain('ENCRYPTION_MASTER_KEY=');
      }
    });

    it('T2.4: Served HTML and static same-origin assets leak zero server env secrets', async () => {
      const client = createSessionClient(baseUrl);
      const res = await client.get('/');
      expect(res.status).toBe(200);
      assertNoSecretsInText(res.text);

      const assets = extractHtmlAssets(res.text);
      for (const assetPath of [...assets.sameOriginScripts, ...assets.sameOriginStyles]) {
        const assetRes = await client.get(assetPath);
        expect(assetRes.status).toBe(200);
        assertNoSecretsInText(assetRes.text);
      }
    });

    it('T2.5: GET / with Accept: application/json and HEAD / do not 500', async () => {
      const client = createSessionClient(baseUrl);

      const jsonAcceptRes = await client.get('/', {
        headers: { Accept: 'application/json' },
      });
      expect(jsonAcceptRes.status).toBe(200);

      const headRes = await client.head('/');
      expect(headRes.status).toBe(200);
    });
  },
);

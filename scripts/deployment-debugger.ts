/**
 * Deployment Debugger & Smoke-Test Suite
 * Verifies live or local deployment health, DB/Redis connectivity, static UI serving,
 * multi-tenant session isolation, OAuth flow, duplicate-post protection, and 503 retry recovery.
 *
 * Usage:
 *   pnpm smoke -- --url https://your-app.onrender.com
 *   DEPLOY_URL=http://localhost:3000 pnpm smoke
 */

import process from 'node:process';

interface CheckResult {
  name: string;
  passed: boolean;
  durationMs: number;
  details?: string;
}

function parseArgs(): { baseUrl: string } {
  const args = process.argv.slice(2);
  let baseUrl = process.env.DEPLOY_URL || 'http://localhost:3000';
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    baseUrl = args[urlIdx + 1];
  }
  return { baseUrl: baseUrl.replace(/\/+$/, '') };
}

class CookieSession {
  private cookieHeader = '';

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.cookieHeader) {
      headers.set('Cookie', this.cookieHeader);
    }
    if (init?.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(url, {
      ...init,
      headers,
      redirect: 'manual',
    });

    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie') as string]
          : [];

    for (const raw of setCookies) {
      const pair = raw.split(';')[0]?.trim();
      if (pair) {
        this.cookieHeader = pair;
      }
    }

    return res;
  }

  hasCookie(): boolean {
    return this.cookieHeader.length > 0;
  }
}

async function runCheck(
  results: CheckResult[],
  name: string,
  fn: () => Promise<string | void>
): Promise<void> {
  const start = Date.now();
  try {
    const details = await fn();
    results.push({
      name,
      passed: true,
      durationMs: Date.now() - start,
      details: details || undefined,
    });
  } catch (error) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  const { baseUrl } = parseArgs();
  const results: CheckResult[] = [];
  const primary = new CookieSession();
  const secondary = new CookieSession();

  let mode = 'live' as 'mock' | 'live';

  await runCheck(results, '1. GET /api/health (DB + Redis + Overdue Recovery)', async () => {
    const res = await primary.fetch(`${baseUrl}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200 || body.status !== 'ok' || body.db !== 'ok' || body.redis !== 'ok') {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    mode = body.mode === 'mock' ? 'mock' : 'live';
    return `mode=${mode}, recoveredPosts=${String(body.recoveredPosts ?? 0)}`;
  });

  await runCheck(results, '2. GET / (Static Next.js UI served by NestJS)', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    if (res.status !== 200 || !html.includes('LinkedIn Post Scheduler')) {
      throw new Error(`HTTP ${res.status}, expected LinkedIn Post Scheduler HTML`);
    }
    return `HTTP 200 (${html.length} bytes)`;
  });

  await runCheck(results, '3. Multi-tenant session cookie issued on /api/account', async () => {
    const res = await primary.fetch(`${baseUrl}/api/account`);
    if (res.status !== 200 || !primary.hasCookie()) {
      throw new Error(`Expected 200 + li_scheduler_sid cookie, got HTTP ${res.status}`);
    }
    return 'li_scheduler_sid issued';
  });

  await runCheck(results, '4. GET /api/auth/linkedin/url returns valid OAuth URL', async () => {
    const res = await primary.fetch(`${baseUrl}/api/auth/linkedin/url`);
    const body = (await res.json()) as { url?: string };
    if (res.status !== 200 || !body.url) {
      throw new Error(`Missing OAuth URL: HTTP ${res.status}`);
    }
    if (mode === 'live' && !body.url.startsWith('https://www.linkedin.com/oauth/v2/authorization')) {
      throw new Error(`Unexpected live OAuth URL: ${body.url}`);
    }
    return body.url.slice(0, 64);
  });

  if (mode === 'mock') {
    await runCheck(results, '5. Mock OAuth callback + tenant isolation', async () => {
      const urlRes = await primary.fetch(`${baseUrl}/api/auth/linkedin/url`);
      const { url } = (await urlRes.json()) as { url: string };
      const cbUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
      const cbRes = await primary.fetch(cbUrl);
      if (cbRes.status !== 302 || !cbRes.headers.get('location')?.includes('auth=success')) {
        throw new Error(`Callback failed: HTTP ${cbRes.status} -> ${cbRes.headers.get('location')}`);
      }

      const acc1 = (await (await primary.fetch(`${baseUrl}/api/account`)).json()) as {
        connected: boolean;
      };
      const acc2 = (await (await secondary.fetch(`${baseUrl}/api/account`)).json()) as {
        connected: boolean;
      };
      if (!acc1.connected || acc2.connected) {
        throw new Error(`Isolation failed: acc1=${acc1.connected}, acc2=${acc2.connected}`);
      }
      return 'Primary connected; secondary isolated';
    });

    const content = `Deployment debugger verification ${Date.now()}`;
    const scheduledIso = new Date(Date.now() + 1000).toISOString();
    let scheduledPostId = '';

    await runCheck(results, '6. Enable 503 simulation + schedule + 409 duplicate check', async () => {
      const toggleRes = await primary.fetch(`${baseUrl}/api/test/toggle-simulate-failure`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true }),
      });
      if (toggleRes.status !== 200) {
        throw new Error(`Toggle failed: HTTP ${toggleRes.status}`);
      }

      const schedRes = await primary.fetch(`${baseUrl}/api/posts/schedule`, {
        method: 'POST',
        body: JSON.stringify({ content, scheduledFor: scheduledIso }),
      });
      const schedBody = (await schedRes.json()) as { post?: { id: string } };
      if (schedRes.status !== 201 || !schedBody.post?.id) {
        throw new Error(`Schedule failed: HTTP ${schedRes.status}`);
      }
      scheduledPostId = schedBody.post.id;

      const dupRes = await primary.fetch(`${baseUrl}/api/posts/schedule`, {
        method: 'POST',
        body: JSON.stringify({ content, scheduledFor: scheduledIso }),
      });
      if (dupRes.status !== 409) {
        throw new Error(`Expected 409 Conflict on duplicate, got HTTP ${dupRes.status}`);
      }
      return `Scheduled ${scheduledPostId}; duplicate rejected (409)`;
    });

    await runCheck(results, '7. BullMQ 503 retry -> exponential backoff -> published', async () => {
      if (!scheduledPostId) throw new Error('No post scheduled');
      const deadline = Date.now() + 20_000;
      let finalPost: { status: string; retryCount: number; externalPostUrn?: string } | null = null;

      while (Date.now() < deadline) {
        const listRes = await primary.fetch(`${baseUrl}/api/posts`);
        const { posts } = (await listRes.json()) as {
          posts: Array<{ id: string; status: string; retryCount: number; externalPostUrn?: string }>;
        };
        const found = posts.find((p) => p.id === scheduledPostId);
        if (found && found.status === 'published') {
          finalPost = found;
          break;
        }
        await new Promise((r) => setTimeout(r, 750));
      }

      await primary.fetch(`${baseUrl}/api/test/toggle-simulate-failure`, {
        method: 'POST',
        body: JSON.stringify({ enabled: false }),
      });

      if (!finalPost) {
        throw new Error('Timed out waiting for post to publish after 503 retry');
      }
      if (finalPost.retryCount < 1 || !finalPost.externalPostUrn) {
        throw new Error(`Expected retryCount >= 1 and URN, got ${JSON.stringify(finalPost)}`);
      }
      return `Published after ${finalPost.retryCount} retry (${finalPost.externalPostUrn})`;
    });

    await runCheck(results, '8. Schedule future post + cancel (removes DB & BullMQ job)', async () => {
      const futureRes = await primary.fetch(`${baseUrl}/api/posts/schedule`, {
        method: 'POST',
        body: JSON.stringify({
          content: `Cancel smoke test ${Date.now()}`,
          scheduledFor: new Date(Date.now() + 60_000).toISOString(),
        }),
      });
      const { post } = (await futureRes.json()) as { post: { id: string } };
      const cancelRes = await primary.fetch(`${baseUrl}/api/posts/${post.id}/cancel`, {
        method: 'POST',
      });
      if (cancelRes.status !== 200) {
        throw new Error(`Cancel failed: HTTP ${cancelRes.status}`);
      }
      return `Canceled ${post.id}`;
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  const allPassed = passedCount === results.length;

  console.log(
    JSON.stringify(
      {
        target: baseUrl,
        mode,
        passed: passedCount,
        total: results.length,
        ok: allPassed,
        results,
      },
      null,
      2
    )
  );

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Deployment debugger crashed:', err);
  process.exit(1);
});

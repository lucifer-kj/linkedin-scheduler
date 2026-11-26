import { ILinkedInClient, LinkedInTokenResponse, LinkedInPublishResult, LinkedInApiError } from './types.js';

export interface LinkedInClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiVersion: string;
}

export interface LinkedInClientLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const noopLogger: LinkedInClientLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now()
): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    return undefined;
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }

  return undefined;
}

/**
 * Real LinkedIn API Client
 * Uses LinkedIn OAuth 2.0 and LinkedIn Community Management / Posts REST API (/rest/posts).
 */
export class RealLinkedInClient implements ILinkedInClient {
  private readonly config: LinkedInClientConfig;
  private readonly logger: LinkedInClientLogger;

  constructor(config?: Partial<LinkedInClientConfig>, logger?: LinkedInClientLogger) {
    this.config = {
      clientId: config?.clientId ?? process.env.LINKEDIN_CLIENT_ID ?? 'mock_client_id',
      clientSecret: config?.clientSecret ?? process.env.LINKEDIN_CLIENT_SECRET ?? 'mock_client_secret',
      redirectUri:
        config?.redirectUri ??
        process.env.LINKEDIN_REDIRECT_URI ??
        'http://localhost:3000/api/auth/linkedin/callback',
      apiVersion: config?.apiVersion ?? process.env.LINKEDIN_API_VERSION ?? '202501',
    };
    this.logger = logger ?? noopLogger;
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      state,
      scope: 'openid profile email w_member_social',
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      this.logger.error({ status: response.status, errorText }, 'Failed to exchange LinkedIn authorization code');
      throw new LinkedInApiError(`LinkedIn OAuth Token exchange failed: ${errorText}`, response.status);
    }

    const tokenData = (await response.json()) as { access_token: string; expires_in: number };

    const profileResponse = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!profileResponse.ok) {
      throw new LinkedInApiError('Failed to fetch LinkedIn user profile', profileResponse.status);
    }

    const profileData = (await profileResponse.json()) as { sub: string; name?: string; email?: string };

    return {
      accessToken: tokenData.access_token,
      expiresIn: tokenData.expires_in,
      personUrn: `urn:li:person:${profileData.sub}`,
      name: profileData.name || 'LinkedIn User',
      email: profileData.email || 'user@linkedin.com',
    };
  }

  async publishPost(
    accessToken: string,
    personUrn: string,
    text: string,
    idempotencyKey: string
  ): Promise<LinkedInPublishResult> {
    const payload = {
      author: personUrn,
      commentary: text,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };

    const response = await fetch('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': this.config.apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const retryAfterMs =
        response.status === 429 ? parseRetryAfterMs(response.headers.get('retry-after')) : undefined;
      this.logger.warn(
        { status: response.status, retryAfterMs, errorBody },
        'LinkedIn /rest/posts API error'
      );
      throw new LinkedInApiError(
        `LinkedIn publishing failed (${response.status}): ${errorBody}`,
        response.status,
        retryAfterMs
      );
    }

    const restliId = response.headers.get('x-restli-id')?.trim();
    let postUrn = restliId && restliId.length > 0 ? restliId : undefined;

    if (!postUrn) {
      const rawBody = await response.text();
      if (rawBody.trim().length > 0) {
        try {
          const data = JSON.parse(rawBody) as { id?: string };
          if (typeof data.id === 'string' && data.id.trim().length > 0) {
            postUrn = data.id.trim();
          }
        } catch {
          // Ignore non-JSON empty/text bodies when x-restli-id is missing
        }
      }
    }

    return {
      postUrn: postUrn || `urn:li:share:${Date.now()}`,
      status: 'SUCCESS',
    };
  }
}

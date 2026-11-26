import { ILinkedInClient, LinkedInTokenResponse, LinkedInPublishResult, LinkedInApiError } from './types.js';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

/**
 * Real LinkedIn API Client
 * Uses LinkedIn OAuth 2.0 and LinkedIn REST ugcPosts API
 */
export class RealLinkedInClient implements ILinkedInClient {
  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.LINKEDIN_CLIENT_ID,
      redirect_uri: config.LINKEDIN_REDIRECT_URI,
      state: state,
      scope: 'openid profile email w_member_social',
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: config.LINKEDIN_REDIRECT_URI,
      client_id: config.LINKEDIN_CLIENT_ID,
      client_secret: config.LINKEDIN_CLIENT_SECRET,
    });

    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, errorText }, 'Failed to exchange LinkedIn authorization code');
      throw new LinkedInApiError(`LinkedIn OAuth Token exchange failed: ${errorText}`, response.status);
    }

    const tokenData = (await response.json()) as { access_token: string; expires_in: number };

    // Fetch user profile info using OpenID Connect endpoint
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
      lifecycleState: 'PUBLISHED',
      specificContent: {
        'com.linkedin.ugc.ShareContent': {
          shareCommentary: {
            text: text,
          },
          shareMediaCategory: 'NONE',
        },
      },
      visibility: {
        'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
      },
    };

    const response = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger.warn({ status: response.status, errorBody }, 'LinkedIn UGC Post API error');
      throw new LinkedInApiError(`LinkedIn publishing failed (${response.status}): ${errorBody}`, response.status);
    }

    const data = (await response.json()) as { id?: string };
    const postUrn = data.id || `urn:li:share:${Date.now()}`;

    return {
      postUrn,
      status: 'SUCCESS',
    };
  }
}

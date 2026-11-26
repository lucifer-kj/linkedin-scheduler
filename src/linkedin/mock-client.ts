import { ILinkedInClient, LinkedInTokenResponse, LinkedInPublishResult, LinkedInApiError } from './types.js';
import { logger } from '../logger/index.js';

/**
 * Mock LinkedIn API Client
 * Enables evaluation without requiring an active approved LinkedIn Developer App.
 * Includes controlled transient error simulation to verify exponential retries.
 */
export class MockLinkedInClient implements ILinkedInClient {
  public static simulateTransientFailure = false;
  private static failedAttempts = new Set<string>();

  getAuthorizationUrl(state: string): string {
    return `/api/auth/linkedin/callback?code=mock_auth_code_12345&state=${state}`;
  }

  async exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse> {
    logger.info({ code }, '[MOCK LINKEDIN] Exchanging authorization code for token');
    return {
      accessToken: `mock_access_token_${Date.now()}`,
      expiresIn: 5184000, // 60 days in seconds
      personUrn: 'urn:li:person:mock-engineer-99',
      name: 'Senior Candidate (Evaluation Account)',
      email: 'candidate@example.com',
    };
  }

  async publishPost(
    accessToken: string,
    personUrn: string,
    text: string,
    idempotencyKey: string,
    retryAttempt: number = 0
  ): Promise<LinkedInPublishResult> {
    logger.info(
      { personUrn, contentLength: text.length, idempotencyKey, retryAttempt },
      '[MOCK LINKEDIN] Publishing post to LinkedIn'
    );

    // Simulate transient failure on the first attempt if test simulation is enabled
    if (MockLinkedInClient.simulateTransientFailure && retryAttempt === 0 && !MockLinkedInClient.failedAttempts.has(idempotencyKey)) {
      MockLinkedInClient.failedAttempts.add(idempotencyKey);
      logger.warn(
        { idempotencyKey },
        '[MOCK LINKEDIN] Injected transient HTTP 503 (Service Unavailable) to trigger automatic exponential backoff retry.'
      );
      throw new LinkedInApiError(
        'Simulated LinkedIn API transient failure (HTTP 503 Service Unavailable). Will be automatically retried with exponential backoff.',
        503
      );
    }

    // Simulate standard network latency (150ms)
    await new Promise((resolve) => setTimeout(resolve, 150));

    const simulatedPostId = `urn:li:share:mock-${Date.now().toString(36)}`;
    logger.info({ simulatedPostId }, '[MOCK LINKEDIN] Post published successfully!');

    return {
      postUrn: simulatedPostId,
      status: 'SUCCESS',
    };
  }
}

import { ILinkedInClient, LinkedInTokenResponse, LinkedInPublishResult, LinkedInApiError } from './types.js';
import type { LinkedInClientLogger } from './client.js';

const noopLogger: LinkedInClientLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Mock LinkedIn API Client
 * Enables evaluation without requiring an active approved LinkedIn Developer App.
 * Includes controlled transient error simulation to verify exponential retries.
 */
export class MockLinkedInClient implements ILinkedInClient {
  public static simulateTransientFailure = false;
  private static failedAttempts = new Set<string>();
  private readonly logger: LinkedInClientLogger;

  constructor(logger?: LinkedInClientLogger) {
    this.logger = logger ?? noopLogger;
  }

  static setSimulateTransientFailure(enabled: boolean): boolean {
    MockLinkedInClient.simulateTransientFailure = enabled;
    if (!enabled) {
      MockLinkedInClient.failedAttempts.clear();
    }
    return MockLinkedInClient.simulateTransientFailure;
  }

  static toggleSimulateTransientFailure(): boolean {
    return MockLinkedInClient.setSimulateTransientFailure(!MockLinkedInClient.simulateTransientFailure);
  }

  static reset(): void {
    MockLinkedInClient.simulateTransientFailure = false;
    MockLinkedInClient.failedAttempts.clear();
  }

  getAuthorizationUrl(state: string): string {
    return `/api/auth/linkedin/callback?code=mock_auth_code_12345&state=${state}`;
  }

  async exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse> {
    this.logger.info({ code }, '[MOCK LINKEDIN] Exchanging authorization code for token');
    return {
      accessToken: `mock_access_token_${Date.now()}`,
      expiresIn: 5184000, // 60 days in seconds
      personUrn: 'urn:li:person:mock-engineer-99',
      name: 'Senior Candidate (Evaluation Account)',
      email: 'candidate@example.com',
    };
  }

  async publishPost(
    _accessToken: string,
    personUrn: string,
    text: string,
    idempotencyKey: string,
    retryAttempt: number = 0
  ): Promise<LinkedInPublishResult> {
    this.logger.info(
      { personUrn, contentLength: text.length, idempotencyKey, retryAttempt },
      '[MOCK LINKEDIN] Publishing post to LinkedIn'
    );

    if (
      MockLinkedInClient.simulateTransientFailure &&
      retryAttempt === 0 &&
      !MockLinkedInClient.failedAttempts.has(idempotencyKey)
    ) {
      MockLinkedInClient.failedAttempts.add(idempotencyKey);
      this.logger.warn(
        { idempotencyKey },
        '[MOCK LINKEDIN] Injected transient HTTP 503 (Service Unavailable) to trigger automatic exponential backoff retry.'
      );
      throw new LinkedInApiError(
        'Simulated LinkedIn API transient failure (HTTP 503 Service Unavailable). Will be automatically retried with exponential backoff.',
        503
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const simulatedPostId = `urn:li:share:mock-${Date.now().toString(36)}`;
    this.logger.info({ simulatedPostId }, '[MOCK LINKEDIN] Post published successfully!');

    return {
      postUrn: simulatedPostId,
      status: 'SUCCESS',
    };
  }
}

export interface LinkedInTokenResponse {
  accessToken: string;
  expiresIn: number;
  personUrn: string;
  name: string;
  email: string;
}

export interface LinkedInPublishResult {
  postUrn: string;
  status: 'SUCCESS';
}

export class LinkedInApiError extends Error {
  public statusCode: number;
  public isTransient: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'LinkedInApiError';
    this.statusCode = statusCode;
    // Transient errors: 429 (Rate Limit) or 5xx server errors
    this.isTransient = statusCode === 429 || (statusCode >= 500 && statusCode <= 504);
  }
}

export interface ILinkedInClient {
  getAuthorizationUrl(state: string): string;
  exchangeCodeForToken(code: string): Promise<LinkedInTokenResponse>;
  publishPost(
    accessToken: string,
    personUrn: string,
    text: string,
    idempotencyKey: string,
    retryAttempt?: number
  ): Promise<LinkedInPublishResult>;
}

export type PostStatus = 'scheduled' | 'processing' | 'published' | 'failed';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  redis: 'ok' | 'error';
  recoveredPosts: number;
  mode: 'mock' | 'live';
  simulateTransientFailure: boolean;
  timestamp: string;
}

export interface AccountStatusResponse {
  connected: boolean;
  isExpired: boolean;
  hasCustomCredentials: boolean;
  mode: 'mock' | 'live';
  account: {
    id: string;
    linkedinName: string;
    linkedinPersonUrn: string;
    expiresAt: string;
    createdAt: string;
  } | null;
}

export interface PostRecord {
  id: string;
  userId: string;
  linkedinAccountId: string | null;
  content: string;
  scheduledFor: string;
  status: PostStatus;
  idempotencyKey: string;
  bullmqJobId: string | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  externalPostUrn: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.message === 'string'
          ? data.message
          : `Request failed with HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const api = {
  getHealth: () => requestJson<HealthResponse>('/api/health'),
  getAccount: () => requestJson<AccountStatusResponse>('/api/account'),
  getAuthUrl: () => requestJson<{ url: string }>('/api/auth/linkedin/url'),
  saveCredentials: (clientId: string, clientSecret: string) =>
    requestJson<{ ok: true; hasCustomCredentials: true }>('/api/account/credentials', {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  deleteCredentials: () =>
    requestJson<{ ok: true; hasCustomCredentials: false }>('/api/account/credentials', {
      method: 'DELETE',
    }),
  disconnectAccount: () =>
    requestJson<{ ok: true; connected: false }>('/api/account/disconnect', {
      method: 'POST',
    }),
  listPosts: () => requestJson<{ posts: PostRecord[] }>('/api/posts'),
  schedulePost: (content: string, scheduledFor: string) =>
    requestJson<{ message: string; post: PostRecord }>('/api/posts/schedule', {
      method: 'POST',
      body: JSON.stringify({ content, scheduledFor }),
    }),
  cancelPost: (id: string) =>
    requestJson<{ message: string }>(`/api/posts/${id}/cancel`, {
      method: 'POST',
    }),
  toggleSimulateFailure: (enabled?: boolean) =>
    requestJson<{ simulateTransientFailure: boolean; message: string }>(
      '/api/test/toggle-simulate-failure',
      {
        method: 'POST',
        body: JSON.stringify(typeof enabled === 'boolean' ? { enabled } : {}),
      }
    ),
};

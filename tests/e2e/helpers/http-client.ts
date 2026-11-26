export interface ParsedCookie {
  name: string;
  value: string;
  raw: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  path: string | null;
  attributes: Record<string, string | true>;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  location: string | null;
  contentType: string;
  text: string;
  data: T;
  setCookies: ParsedCookie[];
  durationMs: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  rawCookie?: string;
  ignoreSetCookie?: boolean;
  redirect?: RequestInit['redirect'];
}

export function getE2eBaseUrl(): string {
  const raw = process.env.E2E_BASE_URL?.trim();
  if (!raw) {
    throw new Error('E2E_BASE_URL is not set');
  }
  return raw.replace(/\/+$/, '');
}

export function parseSetCookieHeader(raw: string): ParsedCookie {
  const parts = raw.split(';').map((part) => part.trim());
  const [nameValue, ...attrParts] = parts;
  const eqIndex = nameValue.indexOf('=');
  const name = eqIndex >= 0 ? nameValue.slice(0, eqIndex).trim() : nameValue.trim();
  const value = eqIndex >= 0 ? nameValue.slice(eqIndex + 1).trim() : '';

  const attributes: Record<string, string | true> = {};
  let httpOnly = false;
  let secure = false;
  let sameSite: string | null = null;
  let path: string | null = null;

  for (const attr of attrParts) {
    if (!attr) continue;
    const attrEq = attr.indexOf('=');
    if (attrEq === -1) {
      const key = attr.toLowerCase();
      attributes[key] = true;
      if (key === 'httponly') httpOnly = true;
      if (key === 'secure') secure = true;
    } else {
      const key = attr.slice(0, attrEq).trim().toLowerCase();
      const val = attr.slice(attrEq + 1).trim();
      attributes[key] = val;
      if (key === 'samesite') sameSite = val;
      if (key === 'path') path = val;
    }
  }

  return {
    name,
    value,
    raw,
    httpOnly,
    secure,
    sameSite,
    path,
    attributes,
  };
}

export function parseSetCookieHeaders(headers: Headers): ParsedCookie[] {
  const rawCookies = headers.getSetCookie();
  return rawCookies.map(parseSetCookieHeader);
}

export class SessionHttpClient {
  public readonly baseUrl: string;
  private readonly cookieJar = new Map<string, string>();
  private rawCookieHeaderOverride: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setCookie(name: string, value: string): void {
    this.rawCookieHeaderOverride = null;
    this.cookieJar.set(name, value);
  }

  getCookie(name: string): string | undefined {
    return this.cookieJar.get(name);
  }

  setRawCookieHeader(rawHeader: string | null): void {
    this.rawCookieHeaderOverride = rawHeader;
  }

  clearCookies(): void {
    this.cookieJar.clear();
    this.rawCookieHeaderOverride = null;
  }

  buildCookieHeader(override?: string): string | undefined {
    if (override !== undefined) {
      return override;
    }
    if (this.rawCookieHeaderOverride !== null) {
      return this.rawCookieHeaderOverride;
    }
    if (this.cookieJar.size === 0) {
      return undefined;
    }
    return Array.from(this.cookieJar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const targetUrl = path.startsWith('http://') || path.startsWith('https://')
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };

    const cookieHeader = this.buildCookieHeader(options.rawCookie);
    if (cookieHeader !== undefined && cookieHeader.length > 0 && !headers['cookie'] && !headers['Cookie']) {
      headers['Cookie'] = cookieHeader;
    }

    let requestBody: RequestInit['body'];
    if (body instanceof FormData) {
      requestBody = body;
    } else if (typeof body === 'string') {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      requestBody = body;
    } else if (body !== undefined) {
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
      requestBody = JSON.stringify(body);
    }

    const start = Date.now();
    const res = await fetch(targetUrl, {
      method,
      headers,
      body: requestBody,
      redirect: options.redirect ?? 'manual',
    });
    const durationMs = Date.now() - start;

    const setCookies = parseSetCookieHeaders(res.headers);
    if (!options.ignoreSetCookie) {
      for (const cookie of setCookies) {
        this.cookieJar.set(cookie.name, cookie.value);
      }
      if (setCookies.length > 0 && options.rawCookie === undefined) {
        this.rawCookieHeaderOverride = null;
      }
    }

    const text = method === 'HEAD' ? '' : await res.text();
    const contentType = res.headers.get('content-type') ?? '';
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      location: res.headers.get('location'),
      contentType,
      text,
      data: data as T,
      setCookies,
      durationMs,
    };
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, undefined, options);
  }

  head(path: string, options?: RequestOptions): Promise<HttpResponse<unknown>> {
    return this.request<unknown>('HEAD', path, undefined, options);
  }

  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, body, options);
  }

  del<T = unknown>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  postMultipart<T = unknown>(path: string, formData: FormData, options?: RequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, formData, options);
  }
}

export function createSessionClient(baseUrl?: string): SessionHttpClient {
  return new SessionHttpClient(baseUrl ?? getE2eBaseUrl());
}

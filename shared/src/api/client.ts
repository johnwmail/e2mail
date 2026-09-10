import { joinUrl, type Platform } from '../platform';
import type { StandardResponse } from '../types/api';

/** Storage key for the bearer session token (cookie-less auth, supported by the Go backend). */
export const SESSION_TOKEN_KEY = 'e2Mail_token';

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  request<T>(endpoint: string, options?: RequestInit): Promise<T>;
  /** Same auth/URL as `request`, but returns the raw Response (no JSON envelope). */
  raw(endpoint: string, options?: RequestInit): Promise<Response>;
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  translate(key: string, vars?: Record<string, string | number>): string;
}

/**
 * Build an HTTP client bound to a host `Platform`. Behaviour mirrors the web
 * client in `frontend/src/api/client.ts`: bearer token, JSON envelope parsing,
 * and 401 handling (except for the endpoints where 401 is a business error).
 */
export function createHttpClient(platform: Platform): ApiClient {
  const translate =
    platform.translate ?? ((key: string) => key);
  const apiRoot = joinUrl(platform.apiBaseUrl, '/api');

  const getToken = (): Promise<string | null> =>
    Promise.resolve(platform.storage.getItem(SESSION_TOKEN_KEY));

  async function authorized(endpoint: string, options: RequestInit = {}): Promise<Response> {
    const token = await getToken();
    const headers = new Headers(options.headers || {});
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
    if (!headers.has('Content-Type') && !isFormData) {
      headers.set('Content-Type', 'application/json');
    }
    return platform.fetch(joinUrl(apiRoot, endpoint), { ...options, headers });
  }

  async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await authorized(endpoint, options);
    } catch (netErr) {
      const detail = netErr instanceof Error ? netErr.message : String(netErr);
      throw new ApiError(
        translate('api.unreachable', { detail: detail || translate('api.networkTimeout') })
      );
    }

    if (response.status === 401) {
      // 2FA / logout / change-password return 401 for business errors, not session expiry.
      const business401 =
        endpoint.startsWith('/2fa/') ||
        endpoint.startsWith('/auth/logout') ||
        endpoint.startsWith('/auth/change-password');
      if (!business401 && !platform.isPublicRoute?.()) {
        await platform.storage.removeItem(SESSION_TOKEN_KEY);
        platform.onUnauthorized?.();
      }
    }

    const rawText = await response.text();
    let data: StandardResponse<T>;
    try {
      data = JSON.parse(rawText) as StandardResponse<T>;
    } catch {
      // Non-JSON body (e.g. a proxy 502/504 HTML page).
      throw new ApiError(
        translate('api.badGateway', {
          status: response.status,
          statusText: response.statusText,
          body: rawText.slice(0, 120),
        }),
        response.status
      );
    }

    if (!data.success) {
      throw new ApiError(
        data.error || translate('api.requestFailed', { status: response.status }),
        response.status
      );
    }

    return data.data as T;
  }

  return {
    request,
    raw: authorized,
    translate,
    getToken,
    async setToken(value: string) {
      await platform.storage.setItem(SESSION_TOKEN_KEY, value);
    },
    async clearToken() {
      await platform.storage.removeItem(SESSION_TOKEN_KEY);
    },
  };
}

import { StandardResponse } from '../types/api';
import { t } from '../i18n';

const API_BASE = '/api';

export class ApiError extends Error {
  constructor(public message: string, public status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('e2Mail_token');
  const headers = new Headers(options.headers || {});

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const url = `${API_BASE}${endpoint}`;
  let response: Response;

  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (netErr: any) {
    throw new ApiError(
      t('api.unreachable', { detail: netErr.message || t('api.networkTimeout') })
    );
  }

  if (response.status === 401) {
    // 2FA endpoints 的 401 係業務錯誤（驗證碼錯誤），非 session 失效
    // /auth/change-password 的 401 代表舊密碼不正確，同樣唔應該登出
    if (
      !endpoint.startsWith('/2fa/') &&
      !endpoint.startsWith('/auth/logout') &&
      !endpoint.startsWith('/auth/change-password') &&
      !window.location.pathname.includes('/login')
    ) {
      localStorage.removeItem('e2Mail_token');
      localStorage.removeItem('e2Mail_session');
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
  }

  const rawText = await response.text();
  let data: StandardResponse<T>;

  try {
    data = JSON.parse(rawText);
  } catch {
    // 若後端返回非 JSON (如 Nginx 502/504 Bad Gateway HTML)
    throw new ApiError(
      t('api.badGateway', {
        status: response.status,
        statusText: response.statusText,
        body: rawText.slice(0, 120),
      }),
      response.status
    );
  }

  if (!data.success) {
    throw new ApiError(data.error || t('api.requestFailed', { status: response.status }), response.status);
  }

  return data.data as T;
}

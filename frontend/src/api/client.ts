import { StandardResponse } from '../types/api';

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
  const token = localStorage.getItem('webmail_token');
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
    throw new ApiError(`無法連線至後端伺服器 (${netErr.message || '連線逾時或網路中斷'})`);
  }

  if (response.status === 401) {
    localStorage.removeItem('webmail_token');
    localStorage.removeItem('webmail_session');
    if (!window.location.pathname.includes('/login')) {
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
      `後端服務回應異常 [HTTP ${response.status} ${response.statusText}]: ${rawText.slice(0, 120)}`,
      response.status
    );
  }

  if (!data.success) {
    throw new ApiError(data.error || `請求失敗 (HTTP ${response.status})`, response.status);
  }

  return data.data as T;
}

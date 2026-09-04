import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request, ApiError } from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('request', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('attaches bearer token and JSON content-type', async () => {
    localStorage.setItem('e2Mail_token', 'token-123');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/auth/me');
    expect(result).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/me');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer token-123');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('returns data on successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { id: '1' } })));
    const data = await request<{ id: string }>('/auth/me');
    expect(data).toEqual({ id: '1' });
  });

  it('throws ApiError when server reports failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'boom' }, 400)));
    await expect(request('/auth/login')).rejects.toMatchObject({ message: 'boom', status: 400 });
  });

  it('throws ApiError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    await expect(request('/auth/me')).rejects.toThrow(ApiError);
  });

  it('throws ApiError on non-JSON response (nginx 502 html)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 })));
    await expect(request('/auth/me')).rejects.toMatchObject({ status: 502 });
  });

  describe('401 handling', () => {
    it('clears session and dispatches auth:unauthorized for non-2fa endpoints', async () => {
      localStorage.setItem('e2Mail_token', 'tok');
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'expired' }, 401)));

      await expect(request('/auth/me')).rejects.toThrow(ApiError);

      expect(localStorage.getItem('e2Mail_token')).toBeNull();
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth:unauthorized' }));
    });

    it('does NOT clear session for /2fa/ endpoints (business error)', async () => {
      localStorage.setItem('e2Mail_token', 'tok');
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'wrong code' }, 401)));

      await expect(request('/2fa/enable')).rejects.toThrow(ApiError);

      expect(localStorage.getItem('e2Mail_token')).toBe('tok');
      expect(dispatchSpy).not.toHaveBeenCalled();
    });

    it('does NOT clear session for logout endpoint', async () => {
      localStorage.setItem('e2Mail_token', 'tok');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'x' }, 401)));

      await expect(request('/auth/logout', { method: 'POST' })).rejects.toThrow(ApiError);
      expect(localStorage.getItem('e2Mail_token')).toBe('tok');
    });

    it('does NOT dispatch unauthorized when already on login page', async () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, pathname: '/login' },
        writable: true,
      });
      localStorage.setItem('e2Mail_token', 'tok');
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ success: false, error: 'x' }, 401)));

      await expect(request('/auth/me')).rejects.toThrow(ApiError);
      expect(dispatchSpy).not.toHaveBeenCalled();
    });
  });

  it('does not override explicit Authorization header', async () => {
    localStorage.setItem('e2Mail_token', 'tok');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/auth/me', { headers: { Authorization: 'Bearer custom' } });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer custom');
  });

  it('does not set Content-Type for FormData', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: {} }));
    vi.stubGlobal('fetch', fetchMock);

    const form = new FormData();
    form.append('k', 'v');
    await request('/pgp/upload', { method: 'POST', body: form });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });
});
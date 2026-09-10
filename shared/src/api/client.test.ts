import { describe, expect, it, vi } from 'vitest';
import { createHttpClient, SESSION_TOKEN_KEY } from './client';
import { createMemoryStore, type Platform } from '../platform';

function makePlatform(overrides: Partial<Platform> = {}) {
  const storage = overrides.storage ?? createMemoryStore();
  const fetchMock = vi.fn<typeof fetch>();
  const platform: Platform = {
    apiBaseUrl: 'https://mail.example.com',
    fetch: fetchMock,
    storage,
    ...overrides,
  };
  return { platform, fetchMock, storage };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('createHttpClient', () => {
  it('sends the stored token as a bearer header', async () => {
    const { platform, fetchMock, storage } = makePlatform({
      storage: createMemoryStore({ [SESSION_TOKEN_KEY]: 'tok-123' }),
    });
    await storage.setItem(SESSION_TOKEN_KEY, 'tok-123');
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { ok: true } }));

    const client = createHttpClient(platform);
    await client.request('/auth/me');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/api/auth/me');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok-123');
  });

  it('unwraps the StandardResponse data envelope', async () => {
    const { platform, fetchMock } = makePlatform();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { id: 's1' } }));

    const client = createHttpClient(platform);
    await expect(client.request<{ id: string }>('/auth/me')).resolves.toEqual({ id: 's1' });
  });

  it('throws an ApiError carrying the server error message', async () => {
    const { platform, fetchMock } = makePlatform();
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'nope' }, 400));

    const client = createHttpClient(platform);
    await expect(client.request('/x')).rejects.toMatchObject({ message: 'nope', status: 400 });
  });

  it('clears the token and fires onUnauthorized on a session 401', async () => {
    const onUnauthorized = vi.fn();
    const { platform, fetchMock, storage } = makePlatform({ onUnauthorized });
    await storage.setItem(SESSION_TOKEN_KEY, 'tok-123');
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'expired' }, 401));

    const client = createHttpClient(platform);
    await expect(client.request('/mail/folders')).rejects.toBeInstanceOf(Error);

    expect(await storage.getItem(SESSION_TOKEN_KEY)).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('keeps the token on a business 401 from a /2fa/ endpoint', async () => {
    const onUnauthorized = vi.fn();
    const { platform, fetchMock, storage } = makePlatform({ onUnauthorized });
    await storage.setItem(SESSION_TOKEN_KEY, 'tok-123');
    fetchMock.mockResolvedValue(jsonResponse({ success: false, error: 'bad code' }, 401));

    const client = createHttpClient(platform);
    await expect(client.request('/2fa/enable')).rejects.toMatchObject({ message: 'bad code' });

    expect(await storage.getItem(SESSION_TOKEN_KEY)).toBe('tok-123');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

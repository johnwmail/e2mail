import { describe, expect, it, vi } from 'vitest';
import { createAuthApi } from './auth';
import { createHttpClient, SESSION_TOKEN_KEY } from './client';
import { createMemoryStore, type Platform } from '../platform';
import type { LoginResponse, Session } from '../types/api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePlatform() {
  const storage = createMemoryStore();
  const fetchMock = vi.fn<typeof fetch>();
  const platform: Platform = {
    apiBaseUrl: 'https://mail.example.com',
    fetch: fetchMock,
    storage,
  };
  return { platform, fetchMock, storage };
}

const session: Session = {
  id: 's1',
  email: 'user@example.com',
  username: 'user',
  accounts: [],
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: '2026-01-01T00:00:00Z',
};

describe('createAuthApi', () => {
  it('POSTs /auth/login and returns the envelope data', async () => {
    const { platform, fetchMock } = makePlatform();
    const payload: LoginResponse = { token: 'tok', session };
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: payload }));

    const api = createAuthApi(createHttpClient(platform));
    await expect(
      api.login({
        email: 'user@example.com',
        password: 'secret',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      })
    ).resolves.toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/api/auth/login');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: 'user@example.com',
      password: 'secret',
    });
  });

  it('POSTs /auth/verify-2fa', async () => {
    const { platform, fetchMock } = makePlatform();
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { token: 'tok', session } })
    );

    const api = createAuthApi(createHttpClient(platform));
    await api.verify2fa({ challenge: 'ch', code: '123456' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://mail.example.com/api/auth/verify-2fa');
    expect(JSON.parse(String(init?.body))).toEqual({ challenge: 'ch', code: '123456' });
  });

  it('GETs /auth/me', async () => {
    const { platform, fetchMock, storage } = makePlatform();
    await storage.setItem(SESSION_TOKEN_KEY, 'tok-123');
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: session }));

    const api = createAuthApi(createHttpClient(platform));
    await expect(api.getMe()).resolves.toEqual(session);
    expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example.com/api/auth/me');
  });

  it('POSTs /auth/logout', async () => {
    const { platform, fetchMock } = makePlatform();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: null }));

    const api = createAuthApi(createHttpClient(platform));
    await api.logout();
    expect(fetchMock.mock.calls[0][0]).toBe('https://mail.example.com/api/auth/logout');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  it('POSTs /auth/change-password with optional account', async () => {
    const { platform, fetchMock } = makePlatform();
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { changed: true } }));

    const api = createAuthApi(createHttpClient(platform));
    await expect(api.changePassword('old', 'new', 'new', 'acc-1')).resolves.toEqual({
      changed: true,
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      oldPassword: 'old',
      newPassword: 'new',
      confirmPassword: 'new',
      account: 'acc-1',
    });
  });
});

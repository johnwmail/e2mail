import { SESSION_TOKEN_KEY } from '@e2mail/shared';
import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from './useAuthStore';
import { usePrefsStore } from './usePrefsStore';

const secureStore = SecureStore as unknown as { __store: Map<string, string> };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useAuthStore login (P4.1/P4.2)', () => {
  beforeEach(async () => {
    secureStore.__store.clear();
    const { invalidateApiClient } = require('../api');
    invalidateApiClient();
    useAuthStore.setState({
      isLoading: false,
      isAuthenticated: false,
      session: null,
      pendingChallenge: null,
    });
    await usePrefsStore.getState().setApiBaseUrl('https://mail.example.com');
  });

  it('stores the token after a full login', async () => {
    global.fetch = jest.fn(async () =>
      json({
        token: 'tok-1',
        session: { id: 's', email: 'a@b.c', username: 'a', accounts: [], createdAt: '', lastActiveAt: '' },
      })
    ) as unknown as typeof fetch;

    const result = await useAuthStore.getState().login({
      email: 'a@b.c',
      password: 'x',
      imapHost: 'imap.b.c',
      smtpHost: 'smtp.b.c',
    });
    expect(result).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(await SecureStore.getItemAsync(SESSION_TOKEN_KEY)).toBe('tok-1');
  });

  it('returns a 2FA challenge without storing a session token', async () => {
    global.fetch = jest.fn(async () =>
      json({ requires2fa: true, challenge: 'ch-9' })
    ) as unknown as typeof fetch;

    const result = await useAuthStore.getState().login({
      email: 'a@b.c',
      password: 'x',
      imapHost: 'imap.b.c',
      smtpHost: 'smtp.b.c',
    });
    expect(result).toEqual({ requires2fa: true, challenge: 'ch-9' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(await SecureStore.getItemAsync(SESSION_TOKEN_KEY)).toBeNull();
  });
});

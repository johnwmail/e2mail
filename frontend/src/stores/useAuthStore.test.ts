import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from './useAuthStore';
import { authApi } from '../api/auth';
import { Session } from '../types/api';

vi.mock('../api/auth', () => ({
  authApi: {
    login: vi.fn(),
    verify2fa: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
  },
}));

const mockAuthApi = vi.mocked(authApi);

const fakeSession: Session = {
  id: 'sess-1',
  email: 'a@b.c',
  username: 'a@b.c',
  accounts: [
    {
      id: 'acc-1',
      label: 'a@b.c',
      email: 'a@b.c',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapUseTls: true,
      imapAllowInsecureTls: false,
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
      smtpUseTls: true,
      smtpAllowInsecureTls: false,
      username: 'a@b.c',
      isDefault: true,
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
};

const loginReq = {
  email: 'a@b.c',
  password: 'pw',
  imapHost: 'imap.example.com',
  smtpHost: 'smtp.example.com',
};

describe('useAuthStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ token: null, session: null, isAuthenticated: false, isLoading: true });
    vi.clearAllMocks();
  });

  it('login without 2FA stores token + session', async () => {
    mockAuthApi.login.mockResolvedValue({ token: 'tok', session: fakeSession });

    const result = await useAuthStore.getState().login(loginReq);

    expect(result).toBeNull();
    expect(localStorage.getItem('webmail_token')).toBe('tok');
    expect(useAuthStore.getState().token).toBe('tok');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().session?.email).toBe('a@b.c');
  });

  it('login requiring 2FA returns challenge without setting session', async () => {
    mockAuthApi.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    const result = await useAuthStore.getState().login(loginReq);

    expect(result).toEqual({ requires2fa: true, challenge: 'ch-1' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('webmail_token')).toBeNull();
  });

  it('verify2fa completes second stage login', async () => {
    mockAuthApi.verify2fa.mockResolvedValue({ token: 'tok2', session: fakeSession });

    await useAuthStore.getState().verify2fa('ch-1', '123456');

    expect(mockAuthApi.verify2fa).toHaveBeenCalledWith({ challenge: 'ch-1', code: '123456' });
    expect(localStorage.getItem('webmail_token')).toBe('tok2');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('logout clears everything even when API fails', async () => {
    localStorage.setItem('webmail_token', 'tok');
    localStorage.setItem('webmail_session', JSON.stringify(fakeSession));
    useAuthStore.setState({ token: 'tok', session: fakeSession, isAuthenticated: true });
    mockAuthApi.logout.mockRejectedValue(new Error('network'));

    await useAuthStore.getState().logout();

    expect(localStorage.getItem('webmail_token')).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('initAuth with no token finishes loading as unauthenticated', async () => {
    await useAuthStore.getState().initAuth();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });

  it('initAuth with valid token restores session', async () => {
    localStorage.setItem('webmail_token', 'tok');
    mockAuthApi.getMe.mockResolvedValue(fakeSession);

    await useAuthStore.getState().initAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().session?.email).toBe('a@b.c');
    expect(mockAuthApi.getMe).toHaveBeenCalled();
  });

  it('initAuth clears token when getMe fails', async () => {
    localStorage.setItem('webmail_token', 'tok');
    mockAuthApi.getMe.mockRejectedValue(new Error('expired'));

    await useAuthStore.getState().initAuth();

    expect(localStorage.getItem('webmail_token')).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
  });
});
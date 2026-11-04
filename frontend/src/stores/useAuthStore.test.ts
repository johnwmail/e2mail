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

vi.mock('../api/pgp', () => ({
  pgpService: {
    saveKeyPair: vi.fn(),
    getKeyPair: vi.fn(),
    clearKey: vi.fn(),
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
      sieveHost: '',
      sievePort: 0,
      sieveUseTls: true,
      sieveAllowInsecureTls: false,
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
    useAuthStore.setState({ session: null, isAuthenticated: false, isLoading: true });
    vi.clearAllMocks();
  });

  it('login without 2FA keeps the session in memory only', async () => {
    mockAuthApi.login.mockResolvedValue({ token: 'tok', session: fakeSession });

    const result = await useAuthStore.getState().login(loginReq);

    expect(result).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().session?.email).toBe('a@b.c');
    // Session 憑證只放在 HttpOnly cookie，唔可以落 localStorage。
    expect(localStorage.getItem('e2Mail_token')).toBeNull();
    expect(localStorage.getItem('e2Mail_session')).toBeNull();
  });

  it('login requiring 2FA returns challenge without setting session', async () => {
    mockAuthApi.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    const result = await useAuthStore.getState().login(loginReq);

    expect(result).toEqual({ requires2fa: true, challenge: 'ch-1' });
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('e2Mail_token')).toBeNull();
  });

  it('verify2fa completes second stage login', async () => {
    mockAuthApi.verify2fa.mockResolvedValue({ token: 'tok2', session: fakeSession });

    await useAuthStore.getState().verify2fa('ch-1', '123456');

    expect(mockAuthApi.verify2fa).toHaveBeenCalledWith({ challenge: 'ch-1', code: '123456' });
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem('e2Mail_token')).toBeNull();
  });

  it('logout clears everything even when API fails', async () => {
    useAuthStore.setState({ session: fakeSession, isAuthenticated: true });
    mockAuthApi.logout.mockRejectedValue(new Error('network'));

    await useAuthStore.getState().logout();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(localStorage.getItem('e2Mail_token')).toBeNull();
  });

  it('initAuth without a valid cookie finishes loading as unauthenticated', async () => {
    mockAuthApi.getMe.mockRejectedValue(new Error('unauthorized'));

    await useAuthStore.getState().initAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isLoading).toBe(false);
    expect(useAuthStore.getState().session).toBeNull();
  });

  it('initAuth restores session from the HttpOnly cookie', async () => {
    mockAuthApi.getMe.mockResolvedValue(fakeSession);

    await useAuthStore.getState().initAuth();

    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().session?.email).toBe('a@b.c');
    expect(mockAuthApi.getMe).toHaveBeenCalled();
    expect(localStorage.getItem('e2Mail_session')).toBeNull();
  });
});
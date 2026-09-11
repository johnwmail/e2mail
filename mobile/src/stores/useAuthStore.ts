import { create } from 'zustand';
import type { LoginRequest, Session } from '@e2mail/shared';
import { authApi, getApiClient, invalidateApiClient, prefsApi } from '../api';
import { clearPersistedPassphrase } from '../crypto/passphrase';
import { unregisterPushAsync } from '../push/register';
import { usePrefsStore } from './usePrefsStore';
import { useToastStore } from './useToastStore';

export interface LoginResult {
  requires2fa: true;
  challenge: string;
}

interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  session: Session | null;
  pendingChallenge: string | null;
  initAuth: (apiBaseUrl: string) => Promise<void>;
  login: (req: LoginRequest) => Promise<LoginResult | null>;
  verify2fa: (challenge: string, code: string) => Promise<void>;
  logout: (apiBaseUrl: string) => Promise<void>;
  hydrateRemotePrefs: () => Promise<void>;
}

function applySession(session: Session | undefined) {
  return {
    isLoading: false,
    isAuthenticated: true,
    session: session ?? null,
    pendingChallenge: null as string | null,
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoading: true,
  isAuthenticated: false,
  session: null,
  pendingChallenge: null,

  initAuth: async (_apiBaseUrl) => {
    invalidateApiClient();
    const client = getApiClient();
    try {
      const token = await client.getToken();
      if (!token) {
        set({ isLoading: false, isAuthenticated: false, session: null });
        return;
      }
      const session = await authApi().getMe();
      set(applySession(session));
    } catch {
      await client.clearToken();
      set({ isLoading: false, isAuthenticated: false, session: null });
    }
  },

  login: async (req) => {
    const res = await authApi().login(req);
    if (res.requires2fa) {
      set({ pendingChallenge: res.challenge ?? null });
      return { requires2fa: true, challenge: res.challenge! };
    }
    if (!res.token) throw new Error('login returned no token');
    await getApiClient().setToken(res.token);
    set(applySession(res.session));
    return null;
  },

  verify2fa: async (challenge, code) => {
    const res = await authApi().verify2fa({ challenge, code });
    if (!res.token) throw new Error('verify-2fa returned no token');
    await getApiClient().setToken(res.token);
    set(applySession(res.session));
  },

  logout: async (_apiBaseUrl) => {
    try {
      await unregisterPushAsync();
    } catch {
      // Best-effort; logout still proceeds.
    }
    try {
      await authApi().logout();
    } catch {
      // Ignore network errors on logout; still drop local state.
    }
    await getApiClient().clearToken();
    await clearPersistedPassphrase();
    invalidateApiClient();
    set({
      isAuthenticated: false,
      session: null,
      isLoading: false,
      pendingChallenge: null,
    });
    useToastStore.getState().show('Signed out');
  },

  hydrateRemotePrefs: async () => {
    try {
      const api = prefsApi();
      const [mode, theme, locale] = await Promise.all([
        api.get('listMode'),
        api.get('theme'),
        api.get('locale'),
      ]);
      const prefs = usePrefsStore.getState();
      if (mode === 'threads' || mode === 'messages') await prefs.setListMode(mode);
      if (theme === 'light' || theme === 'dark' || theme === 'system') await prefs.setTheme(theme);
      if (locale === 'en' || locale === 'zh-Hant') await prefs.setLocale(locale);
    } catch {
      // Prefs are optional; keep local values.
    }
  },
}));

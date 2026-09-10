import { create } from 'zustand';
import {
  createAuthApi,
  createHttpClient,
  type AuthApi,
  type Session,
} from '@e2mail/shared';
import { createMobilePlatform } from '../platform';
import { useToastStore } from './useToastStore';

interface AuthState {
  isLoading: boolean;
  isAuthenticated: boolean;
  session: Session | null;
  initAuth: (apiBaseUrl: string) => Promise<void>;
  logout: (apiBaseUrl: string) => Promise<void>;
}

function authApi(apiBaseUrl: string, onUnauthorized?: () => void): AuthApi {
  return createAuthApi(
    createHttpClient(createMobilePlatform(apiBaseUrl, { onUnauthorized }))
  );
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoading: true,
  isAuthenticated: false,
  session: null,

  initAuth: async (apiBaseUrl) => {
    const api = authApi(apiBaseUrl, () => {
      set({ isAuthenticated: false, session: null, isLoading: false });
    });
    try {
      const token = await createHttpClient(
        createMobilePlatform(apiBaseUrl)
      ).getToken();
      if (!token) {
        set({ isLoading: false, isAuthenticated: false, session: null });
        return;
      }
      const session = await api.getMe();
      set({ isLoading: false, isAuthenticated: true, session });
    } catch {
      await createHttpClient(createMobilePlatform(apiBaseUrl)).clearToken();
      set({ isLoading: false, isAuthenticated: false, session: null });
    }
  },

  logout: async (apiBaseUrl) => {
    try {
      await authApi(apiBaseUrl).logout();
    } catch {
      // Ignore network errors on logout; still drop local state.
    }
    await createHttpClient(createMobilePlatform(apiBaseUrl)).clearToken();
    set({ isAuthenticated: false, session: null, isLoading: false });
    useToastStore.getState().show('Signed out');
  },
}));

import { create } from 'zustand';
import { authApi } from '../api/auth';
import { LoginRequest, Session } from '../types/api';

interface AuthState {
  token: string | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (req: LoginRequest) => Promise<void>;
  logout: () => Promise<void>;
  initAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('webmail_token'),
  session: localStorage.getItem('webmail_session')
    ? JSON.parse(localStorage.getItem('webmail_session')!)
    : null,
  isAuthenticated: !!localStorage.getItem('webmail_token'),
  isLoading: true,

  login: async (req: LoginRequest) => {
    const res = await authApi.login(req);
    localStorage.setItem('webmail_token', res.token);
    localStorage.setItem('webmail_session', JSON.stringify(res.session));
    set({
      token: res.token,
      session: res.session,
      isAuthenticated: true,
      isLoading: false,
    });
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // 忽略登出網路錯誤
    }
    localStorage.removeItem('webmail_token');
    localStorage.removeItem('webmail_session');
    set({
      token: null,
      session: null,
      isAuthenticated: false,
      isLoading: false,
    });
  },

  initAuth: async () => {
    const token = localStorage.getItem('webmail_token');
    if (!token) {
      set({ isLoading: false, isAuthenticated: false });
      return;
    }

    try {
      const session = await authApi.getMe();
      localStorage.setItem('webmail_session', JSON.stringify(session));
      set({
        token,
        session,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      localStorage.removeItem('webmail_token');
      localStorage.removeItem('webmail_session');
      set({
        token: null,
        session: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },
}));

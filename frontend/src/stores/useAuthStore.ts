import { create } from 'zustand';
import { authApi } from '../api/auth';
import { webauthnApi } from '../api/2fa';
import { pgpService } from '../api/pgp';
import { LoginRequest, LoginResponse, Session } from '../types/api';

export interface LoginResult {
  requires2fa: true;
  challenge: string;
  methods?: string[];
}

interface AuthState {
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (req: LoginRequest) => Promise<LoginResult | null>;
  verify2fa: (challenge: string, code: string) => Promise<void>;
  loginWithWebAuthn: (challenge: string, assertion: unknown) => Promise<void>;
  logout: () => Promise<void>;
  initAuth: () => Promise<void>;
}

// Session 憑證只存在 HttpOnly cookie（由 backend 設定），前端唔再將 token／session
// 寫入 localStorage —— 避免 XSS 可以直接偷走可長期重用的 session ID。
export const useAuthStore = create<AuthState>((set) => {
  const applyLogin = (res: LoginResponse) => {
    set({
      session: res.session ?? null,
      isAuthenticated: true,
      isLoading: false,
    });
  };

  return {
    session: null,
    isAuthenticated: false,
    isLoading: true,

    login: async (req: LoginRequest) => {
      const res = await authApi.login(req);
      if (res.requires2fa) {
        return { requires2fa: true, challenge: res.challenge!, methods: res.methods };
      }
      applyLogin(res);
      return null;
    },

    verify2fa: async (challenge: string, code: string) => {
      const res = await authApi.verify2fa({ challenge, code });
      applyLogin(res);
    },

    loginWithWebAuthn: async (challenge: string, assertion: unknown) => {
      const res = await webauthnApi.loginVerify(challenge, assertion);
      applyLogin(res);
    },

    logout: async () => {
      try {
        await authApi.logout();
      } catch {
        // 忽略登出網路錯誤
      }
      // logout 同時清除 in-memory PGP key（唔留 localStorage），下次登入重新自 server fetch
      pgpService.clearKey();
      set({
        session: null,
        isAuthenticated: false,
        isLoading: false,
      });
    },

    initAuth: async () => {
      // Cookie 會隨 same-origin request 自動送出；每次啟動向 server 確認會話。
      try {
        const session = await authApi.getMe();
        set({
          session,
          isAuthenticated: true,
          isLoading: false,
        });
      } catch {
        set({
          session: null,
          isAuthenticated: false,
          isLoading: false,
        });
      }
    },
  };
});

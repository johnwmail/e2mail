import { request } from './client';
import {
  TwoFASetupResponse,
  TwoFAStatusResponse,
  TwoFAEnableResponse,
  TwoFARegenerateResponse,
  WebAuthnBeginResponse,
  WebAuthnCredential,
  WebAuthnCredentialListResponse,
} from '../types/api';

export const twoFApi = {
  getStatus: async (): Promise<TwoFAStatusResponse> => {
    return request<TwoFAStatusResponse>('/2fa/status');
  },

  setup: async (secret?: string): Promise<TwoFASetupResponse> => {
    return request<TwoFASetupResponse>('/2fa/setup', {
      method: 'POST',
      body: secret ? JSON.stringify({ secret }) : undefined,
    });
  },

  enable: async (secret: string, code: string): Promise<TwoFAEnableResponse> => {
    return request<TwoFAEnableResponse>('/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ secret, code }),
    });
  },

  disable: async (code: string): Promise<void> => {
    return request<void>('/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },

  regenerateBackupCodes: async (code: string): Promise<TwoFARegenerateResponse> => {
    return request<TwoFARegenerateResponse>('/2fa/regenerate-backup-codes', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  },
};

// webauthnApi passkey（WebAuthn 第二因素）。文檔見 docs/PASSKEY.md。
export const webauthnApi = {
  /** 目前使用者已註冊嘅 passkey 清單 */
  list: async (): Promise<WebAuthnCredentialListResponse> => {
    return request<WebAuthnCredentialListResponse>('/2fa/webauthn');
  },

  /** 開始註冊：回傳 creation options 同 ceremony challenge id */
  registerBegin: async (): Promise<WebAuthnBeginResponse> => {
    return request<WebAuthnBeginResponse>('/2fa/webauthn/register/begin', { method: 'POST' });
  },

  /** 完成註冊：body 為 RegistrationResponseJSON（raw） */
  registerFinish: async (
    challenge: string,
    credential: unknown,
    name?: string
  ): Promise<WebAuthnCredential> => {
    const params = new URLSearchParams({ challenge });
    if (name) params.set('name', name);
    return request<WebAuthnCredential>(
      `/2fa/webauthn/register/finish?${params.toString()}`,
      { method: 'POST', body: JSON.stringify(credential) }
    );
  },

  rename: async (id: string, name: string): Promise<void> => {
    return request<void>(`/2fa/webauthn/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  remove: async (id: string): Promise<void> => {
    return request<void>(`/2fa/webauthn/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** 登入第二階段：以 pending login challenge 換取 assertion options */
  loginBegin: async (pendingChallenge: string): Promise<WebAuthnBeginResponse> => {
    return request<WebAuthnBeginResponse>('/auth/webauthn/begin', {
      method: 'POST',
      body: JSON.stringify({ challenge: pendingChallenge }),
    });
  },

  /** 完成登入：body 為 AssertionJSON（raw），回傳 LoginResponse（token + session） */
  loginVerify: async (
    ceremonyChallenge: string,
    assertion: unknown
  ): Promise<import('../types/api').LoginResponse> => {
    return request<import('../types/api').LoginResponse>(
      `/auth/webauthn/verify?challenge=${encodeURIComponent(ceremonyChallenge)}`,
      { method: 'POST', body: JSON.stringify(assertion) }
    );
  },
};
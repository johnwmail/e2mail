import { request } from './client';
import {
  TwoFASetupResponse,
  TwoFAStatusResponse,
  TwoFAEnableResponse,
  TwoFARegenerateResponse,
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
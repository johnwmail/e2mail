import type { ApiClient } from './client';
import type {
  TwoFAEnableResponse,
  TwoFARegenerateResponse,
  TwoFASetupResponse,
  TwoFAStatusResponse,
} from '../types/api';

export function createTwoFaApi(client: ApiClient) {
  return {
    getStatus: (): Promise<TwoFAStatusResponse> => client.request('/2fa/status'),

    setup: (secret?: string): Promise<TwoFASetupResponse> =>
      client.request('/2fa/setup', {
        method: 'POST',
        body: secret ? JSON.stringify({ secret }) : undefined,
      }),

    enable: (secret: string, code: string): Promise<TwoFAEnableResponse> =>
      client.request('/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ secret, code }),
      }),

    disable: (code: string): Promise<void> =>
      client.request('/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),

    regenerateBackupCodes: (code: string): Promise<TwoFARegenerateResponse> =>
      client.request('/2fa/regenerate-backup-codes', {
        method: 'POST',
        body: JSON.stringify({ code }),
      }),
  };
}

export type TwoFaApi = ReturnType<typeof createTwoFaApi>;

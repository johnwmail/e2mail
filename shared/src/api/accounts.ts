import type { ApiClient } from './client';
import type { Account } from '../types/api';

export interface AccountInput {
  label: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapUseTls: boolean;
  imapAllowInsecureTls?: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUseTls: boolean;
  smtpAllowInsecureTls?: boolean;
  sieveHost?: string;
  sievePort?: number;
  sieveUseTls?: boolean;
  sieveAllowInsecureTls?: boolean;
  username: string;
  password?: string;
}

export function createAccountsApi(client: ApiClient) {
  return {
    list: (): Promise<Account[]> => client.request('/accounts'),

    create: (input: AccountInput): Promise<Account> =>
      client.request('/accounts', { method: 'POST', body: JSON.stringify(input) }),

    update: (id: string, input: AccountInput): Promise<void> =>
      client.request(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(input) }),

    remove: (id: string): Promise<void> =>
      client.request(`/accounts/${id}`, { method: 'DELETE' }),

    setDefault: (id: string): Promise<{ isDefault: boolean }> =>
      client.request(`/accounts/${id}/default`, { method: 'POST' }),

    getFolderPrefs: (id: string): Promise<Record<string, boolean>> =>
      client.request(`/accounts/${id}/folders/prefs`),

    setFolderPref: (
      id: string,
      folder: string,
      visible: boolean
    ): Promise<{ visible: boolean }> =>
      client.request(`/accounts/${id}/folders/prefs`, {
        method: 'PUT',
        body: JSON.stringify({ folder, visible }),
      }),

    getFolderOrder: (id: string): Promise<string[]> =>
      client.request(`/accounts/${id}/folders/order`),

    setFolderOrder: (id: string, order: string[]): Promise<{ saved: boolean }> =>
      client.request(`/accounts/${id}/folders/order`, {
        method: 'PUT',
        body: JSON.stringify({ order }),
      }),

    test: (input: AccountInput): Promise<{ imap: string; smtp: string }> =>
      client.request('/accounts/test', { method: 'POST', body: JSON.stringify(input) }),

    ensureJunkFolder: (accountId: string): Promise<{ junkFolder: string }> =>
      client.request(`/accounts/${accountId}/ensure-junk-folder`, { method: 'POST' }),
  };
}

export type AccountsApi = ReturnType<typeof createAccountsApi>;

import { request } from './client';
import { Account } from '../types/api';

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
  username: string;
  password?: string;
}

export const accountsApi = {
  list: async (): Promise<Account[]> => {
    return request<Account[]>('/accounts');
  },

  create: async (input: AccountInput): Promise<Account> => {
    return request<Account>('/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  update: async (id: string, input: AccountInput): Promise<void> => {
    return request<void>(`/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  remove: async (id: string): Promise<void> => {
    return request<void>(`/accounts/${id}`, { method: 'DELETE' });
  },

  setDefault: async (id: string): Promise<{ isDefault: boolean }> => {
    return request<{ isDefault: boolean }>(`/accounts/${id}/default`, { method: 'POST' });
  },

  test: async (input: AccountInput): Promise<{ imap: string; smtp: string }> => {
    return request<{ imap: string; smtp: string }>('/accounts/test', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};

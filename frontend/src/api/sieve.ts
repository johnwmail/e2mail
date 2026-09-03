import { request } from './client';

export interface SieveScriptInfo {
  name: string;
  active: boolean;
  size?: number;
}

function accountQuery(accountId?: string): string {
  if (!accountId) return '';
  return `?account=${encodeURIComponent(accountId)}`;
}

export const sieveApi = {
  capability: (accountId?: string) =>
    request<Record<string, string>>(`/sieve/capability${accountQuery(accountId)}`),

  list: (accountId?: string) =>
    request<SieveScriptInfo[]>(`/sieve/scripts${accountQuery(accountId)}`),

  get: (name: string, accountId?: string) =>
    request<{ name: string; content: string }>(`/sieve/scripts/${encodeURIComponent(name)}${accountQuery(accountId)}`),

  put: (name: string, content: string, accountId?: string) =>
    request<{ name: string; message: string }>(`/sieve/scripts/${encodeURIComponent(name)}${accountQuery(accountId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  remove: (name: string, accountId?: string) =>
    request<{ deleted: boolean }>(`/sieve/scripts/${encodeURIComponent(name)}${accountQuery(accountId)}`, {
      method: 'DELETE',
    }),

  activate: (name: string, accountId?: string) =>
    request<{ active: string }>(`/sieve/scripts/${encodeURIComponent(name)}/activate${accountQuery(accountId)}`, {
      method: 'POST',
    }),

  deactivate: (accountId?: string) =>
    request<{ deactivated: boolean }>(`/sieve/scripts/deactivate${accountQuery(accountId)}`, {
      method: 'POST',
    }),

  check: (content: string, accountId?: string) =>
    request<{ message: string }>(`/sieve/check${accountQuery(accountId)}`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
};

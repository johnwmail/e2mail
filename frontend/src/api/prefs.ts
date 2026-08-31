import { request } from './client';

export const prefsApi = {
  get: async (key: string): Promise<string> => {
    const res = await request<{ key: string; value: string }>(`/prefs/${encodeURIComponent(key)}`);
    return res.value ?? '';
  },
  set: async (key: string, value: string): Promise<void> => {
    await request<void>(`/prefs/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  },
};
import type { ApiClient } from './client';

export function createPrefsApi(client: ApiClient) {
  return {
    get: async (key: string): Promise<string> => {
      const res = await client.request<{ key: string; value: string }>(
        `/prefs/${encodeURIComponent(key)}`
      );
      return res.value ?? '';
    },
    set: async (key: string, value: string): Promise<void> => {
      await client.request(`/prefs/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
    },
  };
}

export type PrefsApi = ReturnType<typeof createPrefsApi>;

import type { ApiClient } from './client';
import type { PushDeviceInfo, PushRegisterRequest } from '../types/api';

export function createPushApi(client: ApiClient) {
  return {
    register: (body: PushRegisterRequest): Promise<{ registered: boolean; platform: string }> =>
      client.request('/push/devices', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    list: (): Promise<PushDeviceInfo[]> => client.request('/push/devices'),
    unregister: (token: string): Promise<void> =>
      client.request(`/push/devices/${encodeURIComponent(token)}`, { method: 'DELETE' }),
  };
}

export type PushApi = ReturnType<typeof createPushApi>;

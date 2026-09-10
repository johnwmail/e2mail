import { createHttpClient, ApiError } from '@e2mail/shared';
import { t } from '../i18n';
import { createBrowserPlatform } from '../platform';

const client = createHttpClient(createBrowserPlatform(t));

export { ApiError };

export function request<T>(path: string, init?: RequestInit): Promise<T> {
  return client.request<T>(path, init);
}

export function getBrowserClient() {
  return client;
}

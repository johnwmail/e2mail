import {
  createAccountsApi,
  createAuthApi,
  createHttpClient,
  createOnboardingApi,
  createMailApi,
  createPrefsApi,
  createPushApi,
  createTwoFaApi,
  type ApiClient,
} from '@e2mail/shared';
import { createPgpService } from '@e2mail/shared/pgp';
import { createMobilePlatform } from './platform';
import { clearPersistedPassphrase } from './crypto/passphrase';
import { usePrefsStore } from './stores/usePrefsStore';

let cached: { url: string; client: ApiClient } | null = null;
let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

export function invalidateApiClient(): void {
  cached = null;
}

export function getApiClient(): ApiClient {
  const url = usePrefsStore.getState().apiBaseUrl;
  if (cached && cached.url === url) return cached.client;
  const client = createHttpClient(
    createMobilePlatform(url, {
      onUnauthorized: () => {
        void clearPersistedPassphrase();
        unauthorizedHandler?.();
      },
    })
  );
  cached = { url, client };
  return client;
}

export function authApi() {
  return createAuthApi(getApiClient());
}

export function mailApi() {
  return createMailApi(getApiClient());
}

export function accountsApi() {
  return createAccountsApi(getApiClient());
}

export function twoFaApi() {
  return createTwoFaApi(getApiClient());
}

export function onboardingApi() {
  return createOnboardingApi(getApiClient());
}

export function prefsApi() {
  return createPrefsApi(getApiClient());
}

export function pushApi() {
  return createPushApi(getApiClient());
}

export function pgpApi() {
  return createPgpService(getApiClient());
}

export async function arrayBufferToBase64(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

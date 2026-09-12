import {
  createAccountsApi,
  createAuthApi,
  createHttpClient,
  createOnboardingApi,
  createMailApi,
  createContactsApi,
  createPrefsApi,
  createPushApi,
  createSieveApi,
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

export function contactsApi() {
  return createContactsApi(getApiClient());
}

export function sieveApi() {
  return createSieveApi(getApiClient());
}

export async function uploadContactAvatar(
  id: string,
  file: { uri: string; name: string; type: string }
): Promise<void> {
  const form = new FormData();
  form.append('file', file as unknown as Blob);
  const res = await getApiClient().raw(`/contacts/${encodeURIComponent(id)}/avatar`, {
    method: 'PUT',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`avatar upload failed: ${res.status}`);
  }
}

export async function importContactsFile(
  file: { uri: string; name: string; type: string },
  mode: 'skip' | 'overwrite' = 'skip'
): Promise<{ saved: number; skipped: string[]; invalid: number }> {
  const form = new FormData();
  form.append('file', file as unknown as Blob);
  const res = await getApiClient().raw(`/contacts/import?mode=${mode}`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    throw new Error(`import failed: ${res.status}`);
  }
  const json = (await res.json()) as { data: { saved: number; skipped: string[]; invalid: number } };
  return json.data;
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

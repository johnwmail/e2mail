import './polyfills';
import { createHttpClient, type ApiClient } from '@e2mail/shared';
import { createPgpService } from '@e2mail/shared/pgp';
import { createMobilePlatform, type MobilePlatformOptions } from '../platform';

export type MobilePgpService = ReturnType<typeof createPgpService>;

/**
 * Shared HTTP client bound to the device `Platform` (SecureStore token, shared
 * i18n translator). Used by the PGP keyring/contacts calls below and, later, by
 * the Phase 4 mail APIs.
 */
export function createMobileClient(
  apiBaseUrl: string,
  options: MobilePlatformOptions = {}
): ApiClient {
  return createHttpClient(createMobilePlatform(apiBaseUrl, options));
}

/**
 * OpenPGP.js service (keygen, keyring sync, contact keys, encrypt/decrypt/sign).
 * The crypto backend is installed by `./polyfills` (P3.1/P3.2); this factory only
 * wires the REST endpoints. Keep the private-key passphrase in memory (see
 * `passphrase.ts`) — never persist it in plaintext.
 */
export function createMobilePgpService(
  apiBaseUrl: string,
  options: MobilePlatformOptions = {}
): MobilePgpService {
  return createPgpService(createMobileClient(apiBaseUrl, options));
}

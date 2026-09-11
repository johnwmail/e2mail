import * as SecureStore from 'expo-secure-store';
import { getLocales } from 'expo-localization';
import { t as sharedTranslate, type KeyValueStore, type Platform } from '@e2mail/shared';

/**
 * Session token only. SecureStore keys must match [A-Za-z0-9._-];
 * `e2Mail_token` is valid. Theme/locale/list-mode live in AsyncStorage.
 */
const tokenStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: async (key, value) => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key) => {
    await SecureStore.deleteItemAsync(key);
  },
};

export function deviceLanguage(): string {
  try {
    return getLocales()[0]?.languageTag ?? 'en';
  } catch {
    return 'en';
  }
}

export interface MobilePlatformOptions {
  onUnauthorized?: () => void;
  language?: string;
  /** Defaults to the shared i18n `t()` (locale set by `configureI18n`/`setLocale`). */
  translate?: Platform['translate'];
}

export function createMobilePlatform(
  apiBaseUrl: string,
  options: MobilePlatformOptions = {}
): Platform {
  return {
    apiBaseUrl,
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: tokenStore,
    language: options.language ?? deviceLanguage(),
    onUnauthorized: options.onUnauthorized,
    translate: options.translate ?? ((key, vars) => sharedTranslate(key, vars)),
  };
}

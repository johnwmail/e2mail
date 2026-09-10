import * as SecureStore from 'expo-secure-store';
import type { KeyValueStore, Platform } from '@e2mail/shared';

/**
 * Session token lives in the OS keychain/keystore, never in AsyncStorage.
 * SecureStore requires keys to match [A-Za-z0-9._-]; `e2Mail_token` is valid.
 */
const secureStore: KeyValueStore = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: async (key, value) => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key) => {
    await SecureStore.deleteItemAsync(key);
  },
};

export function createMobilePlatform(
  apiBaseUrl: string,
  onUnauthorized?: () => void
): Platform {
  return {
    apiBaseUrl,
    fetch,
    storage: secureStore,
    onUnauthorized,
  };
}

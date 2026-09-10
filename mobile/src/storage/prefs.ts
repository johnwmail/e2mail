import AsyncStorage from '@react-native-async-storage/async-storage';

export const PREFS_KEYS = {
  apiBaseUrl: 'e2Mail_apiBaseUrl',
  theme: 'e2Mail_theme',
  locale: 'e2Mail_locale',
  listMode: 'e2Mail_list_mode',
} as const;

export type ThemePreference = 'light' | 'dark' | 'system';
export type ListMode = 'messages' | 'threads';

export const DEFAULT_API_BASE_URL = 'https://mail.example.com';

export async function readPref(key: string): Promise<string | null> {
  return AsyncStorage.getItem(key);
}

export async function writePref(key: string, value: string): Promise<void> {
  await AsyncStorage.setItem(key, value);
}

export async function removePref(key: string): Promise<void> {
  await AsyncStorage.removeItem(key);
}

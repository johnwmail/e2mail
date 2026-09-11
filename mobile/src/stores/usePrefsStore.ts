import { create } from 'zustand';
import {
  DEFAULT_API_BASE_URL,
  PREFS_KEYS,
  readPref,
  writePref,
  type ListMode,
  type ThemePreference,
} from '../storage/prefs';
import { deviceLanguage } from '../platform';
import { localeFromTag, type AppLocale } from '../i18n';

interface PrefsState {
  hydrated: boolean;
  apiBaseUrl: string;
  theme: ThemePreference;
  locale: AppLocale;
  listMode: ListMode;
  hydrate: () => Promise<void>;
  setApiBaseUrl: (url: string) => Promise<void>;
  setTheme: (theme: ThemePreference) => Promise<void>;
  setListMode: (mode: ListMode) => Promise<void>;
  setLocale: (locale: AppLocale) => Promise<void>;
}

function parseTheme(raw: string | null): ThemePreference {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

function parseListMode(raw: string | null): ListMode {
  return raw === 'threads' ? 'threads' : 'messages';
}

export const usePrefsStore = create<PrefsState>((set) => ({
  hydrated: false,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  theme: 'system',
  locale: localeFromTag(deviceLanguage()),
  listMode: 'messages',

  hydrate: async () => {
    const [apiBaseUrl, theme, locale, listMode] = await Promise.all([
      readPref(PREFS_KEYS.apiBaseUrl),
      readPref(PREFS_KEYS.theme),
      readPref(PREFS_KEYS.locale),
      readPref(PREFS_KEYS.listMode),
    ]);
    set({
      hydrated: true,
      apiBaseUrl: apiBaseUrl?.replace(/\/+$/, '') || DEFAULT_API_BASE_URL,
      theme: parseTheme(theme),
      locale: localeFromTag(locale ?? deviceLanguage()),
      listMode: parseListMode(listMode),
    });
  },

  setApiBaseUrl: async (url) => {
    const clean = url.replace(/\/+$/, '');
    await writePref(PREFS_KEYS.apiBaseUrl, clean);
    set({ apiBaseUrl: clean });
  },

  setTheme: async (theme) => {
    await writePref(PREFS_KEYS.theme, theme);
    set({ theme });
  },

  setListMode: async (mode) => {
    await writePref(PREFS_KEYS.listMode, mode);
    set({ listMode: mode });
  },

  setLocale: async (locale) => {
    await writePref(PREFS_KEYS.locale, locale);
    set({ locale });
  },
}));

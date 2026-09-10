import { useSyncExternalStore } from 'react';
import {
  LOCALES,
  LOCALE_STORAGE_KEY,
  configureI18n,
  folderDisplayName,
  formatShortDate,
  getLocale,
  setLocale,
  subscribeLocale,
  t,
  type Locale,
} from '@e2mail/shared';

configureI18n({
  language: typeof navigator !== 'undefined' ? navigator.language : undefined,
  storage:
    typeof localStorage === 'undefined'
      ? undefined
      : {
          getItem: (key) => localStorage.getItem(key),
          setItem: (key, value) => {
            localStorage.setItem(key, value);
          },
          removeItem: (key) => {
            localStorage.removeItem(key);
          },
        },
  onLocaleChange: (locale) => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale === 'zh-Hant' ? 'zh-Hant' : 'en';
    }
  },
});

const stored =
  typeof localStorage === 'undefined' ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
if (stored === 'en' || stored === 'zh-Hant') {
  setLocale(stored);
}

export {
  LOCALES,
  LOCALE_STORAGE_KEY,
  folderDisplayName,
  formatShortDate,
  getLocale,
  setLocale,
  t,
};
export type { Locale };

export function applyDocumentLang(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = getLocale() === 'zh-Hant' ? 'zh-Hant' : 'en';
  }
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as Locale);
  return { t, locale, setLocale };
}

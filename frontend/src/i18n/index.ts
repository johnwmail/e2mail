import { useSyncExternalStore } from 'react';
import { en } from './locales/en';
import { zhHant } from './locales/zh-Hant';

export type Locale = 'en' | 'zh-Hant';
export type TranslateVars = Record<string, string | number>;

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'zh-Hant', label: '繁體中文' },
];

export const LOCALE_STORAGE_KEY = 'webmail_locale';

const catalogs: Record<Locale, Record<string, unknown>> = {
  en,
  'zh-Hant': zhHant,
};

const listeners = new Set<() => void>();

function detectLocale(): Locale {
  if (typeof localStorage === 'undefined') return 'en';
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === 'en' || stored === 'zh-Hant') return stored;
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  return nav.toLowerCase().startsWith('zh') ? 'zh-Hant' : 'en';
}

let currentLocale: Locale = detectLocale();

function lookup(tree: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let node: unknown = tree;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name])
  );
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: string, vars?: TranslateVars): string {
  const text = lookup(catalogs[currentLocale], key) ?? lookup(catalogs.en, key) ?? key;
  return interpolate(text, vars);
}

export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return;
  currentLocale = locale;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale === 'zh-Hant' ? 'zh-Hant' : 'en';
  }
  listeners.forEach((fn) => fn());
}

export function applyDocumentLang(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = currentLocale === 'zh-Hant' ? 'zh-Hant' : 'en';
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'en' as Locale);
  return { t, locale, setLocale };
}

export function folderDisplayName(name: string, specialUse?: string): string {
  const key = (specialUse || name || '').toLowerCase();
  if (key.includes('inbox')) return t('folders.inbox');
  if (key.includes('sent')) return t('folders.sent');
  if (key.includes('draft')) return t('folders.drafts');
  if (key.includes('trash') || key.includes('bin')) return t('folders.trash');
  if (key.includes('junk') || key.includes('spam')) return t('folders.junk');
  if (key.includes('archive')) return t('folders.archive');
  return name;
}

export function formatShortDate(d: Date): string {
  if (currentLocale === 'zh-Hant') {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(d);
}

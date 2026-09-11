import { useCallback } from 'react';
import { translate } from '../i18n';
import { usePrefsStore } from '../stores/usePrefsStore';

export function useT() {
  const locale = usePrefsStore((s) => s.locale);
  return useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale]
  );
}

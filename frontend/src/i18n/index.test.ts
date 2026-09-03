import { describe, it, expect, beforeEach } from 'vitest';
import { getLocale, setLocale, t } from './index';

describe('i18n', () => {
  beforeEach(() => {
    setLocale('en');
  });

  it('returns English by default', () => {
    expect(t('login.title')).toBe('Sign in to e2Mail');
    expect(t('common.save')).toBe('Save');
  });

  it('switches to Traditional Chinese templates', () => {
    setLocale('zh-Hant');
    expect(getLocale()).toBe('zh-Hant');
    expect(t('login.title')).toBe('登入 e2Mail');
    expect(t('settings.language')).toBe('語言');
  });

  it('interpolates variables', () => {
    expect(t('sieve.ruleN', { n: 3 })).toBe('Rule 3');
    setLocale('zh-Hant');
    expect(t('sieve.ruleN', { n: 3 })).toBe('規則 3');
  });

  it('falls back to English for missing keys', () => {
    setLocale('zh-Hant');
    expect(t('login.signIn')).toBe('登入信箱');
  });
});

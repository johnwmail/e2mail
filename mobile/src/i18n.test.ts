import { localeFromTag, translate } from './i18n';

describe('localeFromTag', () => {
  it('maps zh* to zh-Hant', () => {
    expect(localeFromTag('zh-HK')).toBe('zh-Hant');
    expect(localeFromTag('zh-TW')).toBe('zh-Hant');
  });

  it('falls back to en', () => {
    expect(localeFromTag(undefined)).toBe('en');
    expect(localeFromTag('fr-FR')).toBe('en');
  });
});

describe('translate', () => {
  it('interpolates variables', () => {
    expect(translate('en', 'home.signedInAs', { email: 'a@b.c' })).toBe(
      'Signed in as a@b.c'
    );
  });

  it('falls back to the key', () => {
    expect(translate('en', 'missing.key')).toBe('missing.key');
  });
});

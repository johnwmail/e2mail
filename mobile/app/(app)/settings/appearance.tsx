import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LOCALES } from '@e2mail/shared';
import { prefsApi } from '../../../src/api';
import { ChoiceChips } from '../../../src/components/ChoiceChips';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { usePrefsStore } from '../../../src/stores/usePrefsStore';
import { useThemeTokens } from '../../../src/theme/useTheme';
import type { AppLocale } from '../../../src/i18n';
import type { ListMode, ThemePreference } from '../../../src/storage/prefs';

export default function AppearanceScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const theme = usePrefsStore((s) => s.theme);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const locale = usePrefsStore((s) => s.locale);
  const setLocale = usePrefsStore((s) => s.setLocale);
  const listMode = usePrefsStore((s) => s.listMode);
  const setListMode = usePrefsStore((s) => s.setListMode);

  const persist = async (key: string, value: string) => {
    try {
      await prefsApi().set(key, value);
    } catch {
      // local value already saved
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.appearance')} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h, { color: colors.text }]}>{t('settings.language')}</Text>
        <Text style={{ color: colors.textMuted }}>{t('settings.languageHint')}</Text>
        <ChoiceChips
          value={locale}
          options={LOCALES.map((l) => ({ id: l.id as AppLocale, label: l.label }))}
          onChange={(id) => {
            void setLocale(id);
            void persist('locale', id);
          }}
        />

        <Text style={[styles.h, { color: colors.text }]}>{t('settings.theme')}</Text>
        <Text style={{ color: colors.textMuted }}>{t('settings.themeHint')}</Text>
        <ChoiceChips<ThemePreference>
          value={theme}
          options={[
            { id: 'system', label: t('settings.themeSystem') },
            { id: 'light', label: t('settings.themeLight') },
            { id: 'dark', label: t('settings.themeDark') },
          ]}
          onChange={(id) => {
            void setTheme(id);
            void persist('theme', id);
          }}
        />

        <Text style={[styles.h, { color: colors.text }]}>{t('settings.list')}</Text>
        <Text style={{ color: colors.textMuted }}>{t('settings.listHint')}</Text>
        <ChoiceChips<ListMode>
          value={listMode}
          options={[
            { id: 'messages', label: t('settings.listMessages') },
            { id: 'threads', label: t('settings.listThreads') },
          ]}
          onChange={(id) => {
            void setListMode(id);
            void persist('listMode', id);
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  h: { fontSize: 16, fontWeight: '700', marginTop: 8 },
});

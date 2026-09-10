import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { translate } from '../../src/i18n';
import { useAuthStore } from '../../src/stores/useAuthStore';
import { usePrefsStore } from '../../src/stores/usePrefsStore';
import { useThemeTokens } from '../../src/theme/useTheme';
import type { ThemePreference } from '../../src/storage/prefs';

const THEME_OPTIONS: ThemePreference[] = ['light', 'dark', 'system'];

export default function HomeScreen() {
  const colors = useThemeTokens();
  const locale = usePrefsStore((s) => s.locale);
  const apiBaseUrl = usePrefsStore((s) => s.apiBaseUrl);
  const theme = usePrefsStore((s) => s.theme);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const session = useAuthStore((s) => s.session);
  const logout = useAuthStore((s) => s.logout);
  const t = (key: string, vars?: Record<string, string>) =>
    translate(locale, key, vars);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>{t('home.title')}</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>
          {session?.email
            ? t('home.signedInAs', { email: session.email })
            : t('home.noSession')}
        </Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>
          {t('home.placeholder')}
        </Text>

        <Text style={[styles.label, { color: colors.text }]}>{t('home.theme')}</Text>
        <View style={styles.row}>
          {THEME_OPTIONS.map((option) => {
            const selected = theme === option;
            return (
              <Pressable
                key={option}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => void setTheme(option)}
                style={[
                  styles.chip,
                  {
                    borderColor: selected ? colors.primary : colors.border,
                    backgroundColor: selected ? colors.bgMuted : colors.bg,
                    minHeight: 44,
                  },
                ]}
              >
                <Text style={{ color: colors.text, fontWeight: selected ? '700' : '500' }}>
                  {t(`home.theme.${option}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.primary },
            pressed && { opacity: 0.8 },
          ]}
          onPress={() => void logout(apiBaseUrl)}
        >
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>
            {t('home.logout')}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
  },
  button: {
    marginTop: 16,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});

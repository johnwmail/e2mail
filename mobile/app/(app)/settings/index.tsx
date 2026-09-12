import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { useThemeTokens } from '../../../src/theme/useTheme';

const SECTIONS = [
  { href: '/(app)/settings/security', labelKey: 'settings.security', hintKey: 'settings.securityHint' },
  { href: '/(app)/settings/pgp', labelKey: 'settings.pgp', hintKey: 'settings.pgpHint' },
  { href: '/(app)/settings/accounts', labelKey: 'settings.accounts', hintKey: 'settings.accountsHint' },
  { href: '/(app)/settings/sieve', labelKey: 'settings.sieve', hintKey: 'settings.sieveHint' },
  { href: '/(app)/settings/contacts', labelKey: 'settings.contacts', hintKey: 'settings.contactsHint' },
  { href: '/(app)/settings/appearance', labelKey: 'settings.appearance', hintKey: 'settings.appearanceHint' },
  { href: '/(app)/push', labelKey: 'push.title', hintKey: 'push.quietHint' },
] as const;

export default function SettingsHomeScreen() {
  const colors = useThemeTokens();
  const t = useT();
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.title')} />
      <ScrollView contentContainerStyle={styles.body}>
        {SECTIONS.map((s) => (
          <Pressable
            key={s.href}
            accessibilityRole="button"
            accessibilityLabel={t(s.labelKey)}
            accessibilityHint={t(s.hintKey)}
            onPress={() => router.push(s.href)}
            style={[styles.row, { borderColor: colors.border, backgroundColor: colors.bgMuted }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.label, { color: colors.text }]}>{t(s.labelKey)}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>{t(s.hintKey)}</Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 32 },
  row: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    minHeight: 64,
    justifyContent: 'center',
  },
  label: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
});

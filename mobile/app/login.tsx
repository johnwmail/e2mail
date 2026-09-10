import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import { Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError, createHttpClient } from '@e2mail/shared';
import { createMobilePlatform } from '../src/platform';
import { translate } from '../src/i18n';
import { useAuthStore } from '../src/stores/useAuthStore';
import { usePrefsStore } from '../src/stores/usePrefsStore';
import { useThemeTokens } from '../src/theme/useTheme';

export default function LoginScreen() {
  const colors = useThemeTokens();
  const locale = usePrefsStore((s) => s.locale);
  const t = useCallback((key: string) => translate(locale, key), [locale]);
  const storedUrl = usePrefsStore((s) => s.apiBaseUrl);
  const setApiBaseUrl = usePrefsStore((s) => s.setApiBaseUrl);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const hydrated = usePrefsStore((s) => s.hydrated);

  const [baseUrl, setBaseUrl] = useState(storedUrl);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const client = useMemo(
    () => createHttpClient(createMobilePlatform(baseUrl.trim())),
    [baseUrl]
  );

  const probe = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const clean = baseUrl.trim().replace(/\/+$/, '');
      await setApiBaseUrl(clean);
      const config = await client.request<Record<string, unknown>>('/server-config');
      setStatus(JSON.stringify(config, null, 2));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, client, setApiBaseUrl]);

  if (hydrated && !isLoading && isAuthenticated) {
    return <Redirect href="/(app)" />;
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.container}
      >
        <Text style={[styles.title, { color: colors.text }]}>{t('login.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          {t('login.subtitle')}
        </Text>

        <Text style={[styles.label, { color: colors.text }]}>{t('login.serverUrl')}</Text>
        <TextInput
          style={[
            styles.input,
            {
              borderColor: colors.border,
              color: colors.text,
              backgroundColor: colors.bgMuted,
            },
          ]}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://mail.example.com"
          placeholderTextColor={colors.textMuted}
          accessibilityLabel={t('login.serverUrl')}
        />

        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.primary, minHeight: 44 },
            pressed && styles.buttonPressed,
          ]}
          onPress={() => void probe()}
          disabled={loading}
        >
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>
            {loading ? t('login.connecting') : t('login.testConnection')}
          </Text>
        </Pressable>

        {loading ? <ActivityIndicator color={colors.primary} /> : null}
        {error ? (
          <Text style={[styles.error, { color: colors.danger }]}>{error}</Text>
        ) : null}
        {status ? (
          <Text style={[styles.result, { color: colors.text }]}>{status}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 24, gap: 12 },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    minHeight: 44,
  },
  button: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  error: { marginTop: 4, fontSize: 14 },
  result: { marginTop: 4, fontFamily: 'monospace', fontSize: 12 },
});

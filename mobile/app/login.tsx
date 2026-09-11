import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ApiError,
  applyEmailHostHints,
  resolveLoginHosts,
  type MailHostDefaults,
} from '@e2mail/shared';
import { getApiClient, invalidateApiClient } from '../src/api';
import { LabeledInput } from '../src/components/LabeledInput';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { useT } from '../src/hooks/useT';
import { useAuthStore } from '../src/stores/useAuthStore';
import { usePrefsStore } from '../src/stores/usePrefsStore';
import { useThemeTokens } from '../src/theme/useTheme';

const emptyHosts: MailHostDefaults = {
  imapHost: '',
  imapPort: 993,
  smtpHost: '',
  smtpPort: 587,
  allowInsecureTls: false,
};

export default function LoginScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const storedUrl = usePrefsStore((s) => s.apiBaseUrl);
  const setApiBaseUrl = usePrefsStore((s) => s.setApiBaseUrl);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const hydrated = usePrefsStore((s) => s.hydrated);
  const login = useAuthStore((s) => s.login);
  const verify2fa = useAuthStore((s) => s.verify2fa);
  const pendingChallenge = useAuthStore((s) => s.pendingChallenge);
  const hydrateRemotePrefs = useAuthStore((s) => s.hydrateRemotePrefs);

  const [baseUrl, setBaseUrl] = useState(storedUrl);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hosts, setHosts] = useState<MailHostDefaults>(emptyHosts);
  const [defaults, setDefaults] = useState<MailHostDefaults | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBaseUrl(storedUrl);
  }, [storedUrl]);

  const loadServerConfig = useCallback(async () => {
    const clean = baseUrl.trim().replace(/\/+$/, '');
    await setApiBaseUrl(clean);
    invalidateApiClient();
    try {
      const cfg = await getApiClient().request<{ defaults?: MailHostDefaults }>('/server-config');
      if (cfg?.defaults) {
        const d = cfg.defaults;
        setDefaults(d);
        setHosts((prev) => ({
          imapHost: d.imapHost || prev.imapHost,
          imapPort: d.imapPort || prev.imapPort,
          smtpHost: d.smtpHost || prev.smtpHost,
          smtpPort: d.smtpPort || prev.smtpPort,
          allowInsecureTls:
            typeof d.allowInsecureTls === 'boolean' ? d.allowInsecureTls : prev.allowInsecureTls,
        }));
      }
    } catch {
      // Prefill is optional.
    }
  }, [baseUrl, defaults, setApiBaseUrl]);

  useEffect(() => {
    if (hydrated && storedUrl) void loadServerConfig();
    // only on first hydrate
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const onEmailChange = (val: string) => {
    setEmail(val);
    setHosts((prev) => applyEmailHostHints(val, prev, defaults));
  };

  const submitLogin = async () => {
    if (!email.trim() || !password) {
      setError(t('login.needEmailPassword'));
      return;
    }
    const resolved = resolveLoginHosts(email, hosts);
    if ('error' in resolved) {
      setError(t(resolved.error === 'need-email' ? 'login.needEmailPassword' : 'login.needServer'));
      setShowAdvanced(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setApiBaseUrl(baseUrl.trim().replace(/\/+$/, ''));
      invalidateApiClient();
      const result = await login({
        email: resolved.email,
        password,
        imapHost: resolved.imapHost,
        imapPort: hosts.imapPort || 993,
        imapUseTls: true,
        imapAllowInsecureTls: hosts.allowInsecureTls,
        smtpHost: resolved.smtpHost,
        smtpPort: hosts.smtpPort || 587,
        smtpUseTls: true,
        smtpAllowInsecureTls: hosts.allowInsecureTls,
      });
      setPassword('');
      if (!result) await hydrateRemotePrefs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async () => {
    if (!pendingChallenge || !code.trim()) {
      setError(t('login.needCode'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verify2fa(pendingChallenge, code.trim());
      setCode('');
      await hydrateRemotePrefs();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('login.codeError'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (hydrated && !isLoading && isAuthenticated) {
    return <Redirect href="/(app)" />;
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>{t('login.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>{t('login.subtitle')}</Text>

        {pendingChallenge ? (
          <>
            <Text style={[styles.subtitle, { color: colors.text }]}>{t('login.twoFactorTitle')}</Text>
            <Text style={[styles.hint, { color: colors.textMuted }]}>{t('login.twoFactorHint')}</Text>
            <LabeledInput
              label={t('login.verificationCode')}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              accessibilityLabel={t('login.verificationCode')}
            />
            {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
            <PrimaryButton
              label={busy ? t('login.verifying') : t('login.verifyAndSignIn')}
              disabled={busy}
              onPress={() => void submit2fa()}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                useAuthStore.setState({ pendingChallenge: null });
                setCode('');
                setError(null);
              }}
            >
              <Text style={{ color: colors.primary, minHeight: 44, paddingTop: 12 }}>
                {t('login.backToCredentials')}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <LabeledInput
              label={t('login.serverUrl')}
              value={baseUrl}
              onChangeText={setBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://mail.example.com"
              accessibilityLabel={t('login.serverUrl')}
            />
            <PrimaryButton
              label={busy ? t('login.connecting') : t('login.testConnection')}
              disabled={busy}
              onPress={() => void loadServerConfig()}
            />
            <LabeledInput
              label={t('login.email')}
              value={email}
              onChangeText={onEmailChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              accessibilityLabel={t('login.email')}
            />
            <LabeledInput
              label={t('login.mailPassword')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              accessibilityLabel={t('login.mailPassword')}
            />
            <Pressable accessibilityRole="button" onPress={() => setShowPassword((v) => !v)}>
              <Text style={{ color: colors.primary }}>
                {showPassword ? t('login.hidePassword') : t('login.showPassword')}
              </Text>
            </Pressable>

            <Pressable accessibilityRole="button" onPress={() => setShowAdvanced((v) => !v)}>
              <Text style={{ color: colors.primary, minHeight: 44, paddingTop: 8 }}>
                {showAdvanced ? t('login.advancedHide') : t('login.advancedShow')}
              </Text>
            </Pressable>
            {showAdvanced ? (
              <View style={styles.advanced}>
                <LabeledInput
                  label={t('login.imapServer')}
                  value={hosts.imapHost}
                  onChangeText={(imapHost) => setHosts((h) => ({ ...h, imapHost }))}
                  autoCapitalize="none"
                />
                <LabeledInput
                  label="IMAP port"
                  value={String(hosts.imapPort)}
                  onChangeText={(v) => setHosts((h) => ({ ...h, imapPort: Number(v) || 993 }))}
                  keyboardType="number-pad"
                />
                <LabeledInput
                  label={t('login.smtpServer')}
                  value={hosts.smtpHost}
                  onChangeText={(smtpHost) => setHosts((h) => ({ ...h, smtpHost }))}
                  autoCapitalize="none"
                />
                <LabeledInput
                  label="SMTP port"
                  value={String(hosts.smtpPort)}
                  onChangeText={(v) => setHosts((h) => ({ ...h, smtpPort: Number(v) || 587 }))}
                  keyboardType="number-pad"
                />
                <View style={styles.row}>
                  <Text style={{ color: colors.text, flex: 1 }}>{t('login.allowInsecure')}</Text>
                  <Switch
                    value={hosts.allowInsecureTls}
                    onValueChange={(allowInsecureTls) => setHosts((h) => ({ ...h, allowInsecureTls }))}
                  />
                </View>
              </View>
            ) : null}

            {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}
            <PrimaryButton
              label={busy ? t('login.signingIn') : t('login.signIn')}
              disabled={busy}
              onPress={() => void submitLogin()}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 24, gap: 12 },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 14, marginBottom: 4 },
  hint: { fontSize: 13, lineHeight: 20 },
  error: { fontSize: 14 },
  advanced: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
});

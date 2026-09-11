import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, Text } from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '@e2mail/shared';
import { onboardingApi, pgpApi, twoFaApi } from '../src/api';
import { rememberPassphrase } from '../src/crypto/passphrase';
import { LabeledInput } from '../src/components/LabeledInput';
import { PrimaryButton } from '../src/components/PrimaryButton';
import { useT } from '../src/hooks/useT';
import { useAuthStore } from '../src/stores/useAuthStore';
import { useThemeTokens } from '../src/theme/useTheme';

type Step = '2fa' | 'pgp' | 'done';

export default function OnboardingScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const session = useAuthStore((s) => s.session);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [requirePGP, setRequirePGP] = useState(true);
  const [step, setStep] = useState<Step>('2fa');
  const [ready, setReady] = useState(false);
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [pgpName, setPgpName] = useState('');
  const [pgpPassphrase, setPgpPassphrase] = useState('');
  const [importedArmored, setImportedArmored] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      try {
        const st = await onboardingApi().status();
        if (st.completed) {
          router.replace('/(app)');
          return;
        }
        setRequirePGP(st.requirePGP);
        if (st.twoFAEnabled || !st.require2FA) {
          setStep(st.requirePGP && !st.pgpEnabled ? 'pgp' : 'done');
        } else {
          setStep('2fa');
        }
        setReady(true);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
        setReady(true);
      }
    })();
  }, [isAuthenticated]);

  useEffect(() => {
    if (!ready || step !== '2fa') return;
    void (async () => {
      try {
        const status = await twoFaApi().getStatus();
        if (status.enabled) {
          setStep(requirePGP ? 'pgp' : 'done');
          return;
        }
        setBusy(true);
        const res = await twoFaApi().setup();
        setSecret(res.secret);
        setOtpauthUrl(res.otpauthUrl);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : t('onboarding.setupFailed', { error: String(err) }));
      } finally {
        setBusy(false);
      }
    })();
  }, [ready, requirePGP, step, t]);

  if (!isAuthenticated) return <Redirect href="/login" />;
  if (!ready) return null;

  const enable2fa = async () => {
    if (code.length !== 6) {
      setError(t('onboarding.needCode'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await twoFaApi().enable(secret, code);
      setBackupCodes(res.backupCodes);
      setStep(requirePGP ? 'pgp' : 'done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('onboarding.enableFailed'));
    } finally {
      setBusy(false);
    }
  };

  const generatePgp = async () => {
    if (!session?.email) return;
    if (!pgpPassphrase) {
      setError(t('onboarding.needPassphrase'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pgpApi().generateKey(pgpName || 'User', session.email, pgpPassphrase);
      rememberPassphrase(pgpPassphrase);
      setStep('done');
    } catch (err) {
      setError(t('onboarding.generateFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const importPgp = async () => {
    if (!importedArmored.trim()) {
      setError(t('onboarding.needPrivateBlock'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pgpApi().importPersonalKey(importedArmored.trim(), undefined, importPassphrase);
      if (importPassphrase) rememberPassphrase(importPassphrase);
      setStep('done');
    } catch (err) {
      setError(t('onboarding.importFailed', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>{t('onboarding.title')}</Text>
        <Text style={[styles.body, { color: colors.textMuted }]}>{t('onboarding.intro')}</Text>
        <Text style={{ color: colors.primary }}>
          {step === '2fa' ? t('onboarding.step2fa') : t('onboarding.stepPgp')}
        </Text>

        {step === '2fa' ? (
          <>
            <Text style={[styles.body, { color: colors.text }]}>{t('onboarding.twoFaHint')}</Text>
            {secret ? (
              <>
                <Text style={[styles.label, { color: colors.text }]}>{t('onboarding.secret')}</Text>
                <Text selectable style={[styles.mono, { color: colors.text }]}>
                  {secret}
                </Text>
                <PrimaryButton
                  label={t('common.copy')}
                  onPress={() => void Share.share({ message: otpauthUrl || secret })}
                />
              </>
            ) : null}
            <LabeledInput
              label={t('login.verificationCode')}
              value={code}
              onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
              keyboardType="number-pad"
            />
            <PrimaryButton
              label={busy ? t('onboarding.generatingCode') : t('onboarding.verifyContinue')}
              disabled={busy}
              onPress={() => void enable2fa()}
            />
          </>
        ) : null}

        {step === 'pgp' ? (
          <>
            <LabeledInput label={t('onboarding.displayName')} value={pgpName} onChangeText={setPgpName} />
            <LabeledInput
              label={t('onboarding.needPassphrase')}
              value={pgpPassphrase}
              onChangeText={setPgpPassphrase}
              secureTextEntry
            />
            <PrimaryButton
              label={t('onboarding.generateFinish')}
              disabled={busy}
              onPress={() => void generatePgp()}
            />
            <Pressable accessibilityRole="button" onPress={() => setShowImport((v) => !v)}>
              <Text style={{ color: colors.primary, minHeight: 44, paddingTop: 8 }}>
                {t('onboarding.importExisting')}
              </Text>
            </Pressable>
            {showImport ? (
              <>
                <LabeledInput
                  label={t('onboarding.needPrivateBlock')}
                  value={importedArmored}
                  onChangeText={setImportedArmored}
                  multiline
                />
                <LabeledInput
                  label={t('onboarding.importPassphrase')}
                  value={importPassphrase}
                  onChangeText={setImportPassphrase}
                  secureTextEntry
                />
                <PrimaryButton
                  label={t('onboarding.importFinish')}
                  disabled={busy}
                  onPress={() => void importPgp()}
                />
              </>
            ) : null}
          </>
        ) : null}

        {step === 'done' ? (
          <>
            {backupCodes.length ? (
              <>
                <Text style={{ color: colors.text }}>{t('onboarding.backupCodesSave')}</Text>
                <Text selectable style={[styles.mono, { color: colors.text }]}>
                  {backupCodes.join('\n')}
                </Text>
              </>
            ) : null}
            <PrimaryButton label={t('onboarding.enterMailbox')} onPress={() => router.replace('/(app)')} />
          </>
        ) : null}

        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600' },
  mono: { fontFamily: 'monospace', fontSize: 13 },
});

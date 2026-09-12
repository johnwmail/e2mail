import { useEffect, useState } from 'react';
import { Linking, ScrollView, Share, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getApiClient, twoFaApi, authApi } from '../../../src/api';
import { LabeledInput } from '../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { useAuthStore } from '../../../src/stores/useAuthStore';
import { useThemeTokens } from '../../../src/theme/useTheme';

export default function SecurityScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const session = useAuthStore((s) => s.session);
  const accounts = session?.accounts ?? [];
  const loginEmail = (session?.email || '').toLowerCase();

  const [twoFaOn, setTwoFaOn] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [accountId, setAccountId] = useState(accounts.find((a) => a.email.toLowerCase() === loginEmail)?.id ?? accounts[0]?.id ?? '');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = accounts.find((a) => a.id === accountId) ?? accounts[0];
  const isLoginAccount = selected ? selected.email.toLowerCase() === loginEmail : true;

  useEffect(() => {
    void twoFaApi()
      .getStatus()
      .then((s) => setTwoFaOn(!!s.enabled))
      .catch(() => undefined);
    void getApiClient()
      .request<{ ldapEnabled?: boolean }>('/server-config')
      .then((cfg) => setLdapEnabled(!!cfg.ldapEnabled))
      .catch(() => setLdapEnabled(false));
    // Fetch once on mount; status is refreshed after enable/disable actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable2fa = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const setup = await twoFaApi().setup();
      setSecret(setup.secret);
      setOtpauthUrl(setup.otpauthUrl);
      if (setup.otpauthUrl) void Linking.openURL(setup.otpauthUrl).catch(() => undefined);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('security.setupFailed'));
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await twoFaApi().enable(secret, code.trim());
      setTwoFaOn(true);
      setBackupCodes(res.backupCodes ?? []);
      setCode('');
      setMsg(t('security.enabled'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('security.codeError'));
    } finally {
      setBusy(false);
    }
  };

  const disable2fa = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await twoFaApi().disable(code.trim());
      setTwoFaOn(false);
      setSecret('');
      setBackupCodes([]);
      setCode('');
      setMsg(t('security.disabled'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('security.codeError'));
    } finally {
      setBusy(false);
    }
  };

  const regen = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await twoFaApi().regenerateBackupCodes(code.trim());
      setBackupCodes(res.backupCodes ?? []);
      setCode('');
      setMsg(t('security.codesRegen'));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('security.codeError'));
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setMsg(null);
    if (newPw.length < 8) {
      setMsg(t('security.needLength'));
      return;
    }
    if (newPw !== confirmPw) {
      setMsg(t('security.mismatch'));
      return;
    }
    if (newPw === oldPw) {
      setMsg(t('security.sameAsOld'));
      return;
    }
    setBusy(true);
    try {
      await authApi().changePassword(oldPw, newPw, confirmPw, selected?.id);
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
      setMsg(isLoginAccount ? t('security.changed') : t('security.changedAccount', { name: selected?.label || selected?.email || '' }));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : t('security.changeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.security')} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h, { color: colors.text }]}>{twoFaOn ? t('security.twoFaOn') : t('security.twoFaOff')}</Text>
        <Text style={{ color: colors.textMuted }}>{twoFaOn ? t('security.twoFaOnHint') : t('security.twoFaOffHint')}</Text>

        {secret ? (
          <>
            <Text selectable style={{ color: colors.text }}>{t('onboarding.secret')}: {secret}</Text>
            {otpauthUrl ? (
              <PrimaryButton label={t('security.scanQr')} onPress={() => void Linking.openURL(otpauthUrl)} />
            ) : null}
            <LabeledInput label={t('security.sixDigit')} value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" />
            <PrimaryButton label={t('security.enable')} onPress={() => void confirmEnable()} disabled={busy} />
          </>
        ) : !twoFaOn ? (
          <PrimaryButton label={t('security.enable')} onPress={() => void enable2fa()} disabled={busy} />
        ) : (
          <>
            <LabeledInput label={t('login.verificationCode')} value={code} onChangeText={setCode} keyboardType="number-pad" />
            <PrimaryButton label={t('security.disable')} danger onPress={() => void disable2fa()} disabled={busy} />
            <PrimaryButton label={t('security.regenerate')} onPress={() => void regen()} disabled={busy} />
          </>
        )}

        {backupCodes.length ? (
          <View style={[styles.box, { borderColor: colors.border }]}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>{t('security.backupCodesTitle')}</Text>
            <Text style={{ color: colors.textMuted }}>{t('security.backupCodesHint')}</Text>
            <Text selectable style={{ color: colors.text }}>{backupCodes.join('\n')}</Text>
            <PrimaryButton
              label={t('security.copyCodes')}
              onPress={() => void Share.share({ message: backupCodes.join('\n') })}
            />
          </View>
        ) : null}

        {ldapEnabled ? (
          <View style={[styles.box, { borderColor: colors.border }]}>
            <Text style={[styles.h, { color: colors.text }]}>
              {isLoginAccount ? t('security.changePassword') : t('security.changePasswordAccount')}
            </Text>
            <Text style={{ color: colors.textMuted }}>
              {isLoginAccount ? t('security.changePasswordHint') : t('security.changePasswordAccountHint')}
            </Text>
            {accounts.length > 1
              ? accounts.map((a) => (
                  <View key={a.id} style={styles.switchRow}>
                    <Text style={{ color: colors.text, flex: 1 }}>{a.label || a.email}</Text>
                    <Switch value={a.id === selected?.id} onValueChange={() => setAccountId(a.id)} />
                  </View>
                ))
              : null}
            <LabeledInput label={t('security.oldPassword')} value={oldPw} onChangeText={setOldPw} secureTextEntry />
            <LabeledInput label={t('security.newPassword')} value={newPw} onChangeText={setNewPw} secureTextEntry />
            <LabeledInput label={t('security.confirmPassword')} value={confirmPw} onChangeText={setConfirmPw} secureTextEntry />
            <PrimaryButton label={t('security.change')} onPress={() => void changePassword()} disabled={busy} />
          </View>
        ) : null}

        {msg ? (
          <Text style={{ color: colors.text }}>{msg}</Text>
        ) : null}
        {busy ? null : (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>{t('security.backupCodesOnce')}</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  h: { fontSize: 16, fontWeight: '700' },
  box: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8 },
});

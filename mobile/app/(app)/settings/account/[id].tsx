import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { folderDisplayName, type AccountInput } from '@e2mail/shared';
import { accountsApi, mailApi } from '../../../../src/api';
import { LabeledInput } from '../../../../src/components/LabeledInput';
import { PrimaryButton } from '../../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../../src/components/ScreenHeader';
import { useT } from '../../../../src/hooks/useT';
import { accountToForm, emptyAccountForm } from '../../../../src/settings/accountForm';
import { useAuthStore } from '../../../../src/stores/useAuthStore';
import { useThemeTokens } from '../../../../src/theme/useTheme';

export default function AccountEditScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const refreshSession = useAuthStore((s) => s.refreshSession);
  const queryClient = useQueryClient();
  const listQuery = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi().list() });
  const existing = (listQuery.data ?? []).find((a) => a.id === id);
  const [form, setForm] = useState<AccountInput>(emptyAccountForm());
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ imap: string; smtp: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSieve, setShowSieve] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (isNew) {
      setForm(emptyAccountForm());
      setHydrated(true);
      return;
    }
    if (existing) {
      setForm(accountToForm(existing));
      setHydrated(true);
    }
  }, [existing, hydrated, isNew]);

  const set = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const foldersQuery = useQuery({
    queryKey: ['folders', id],
    queryFn: () => mailApi().getFolders(id),
    enabled: !isNew && !!existing,
  });
  const prefsQuery = useQuery({
    queryKey: ['folderPrefs', id],
    queryFn: () => accountsApi().getFolderPrefs(id),
    enabled: !isNew && !!existing,
  });
  const orderQuery = useQuery({
    queryKey: ['folderOrder', id],
    queryFn: () => accountsApi().getFolderOrder(id),
    enabled: !isNew && !!existing,
  });

  const folderList = foldersQuery.data;
  const folders = folderList ?? [];
  const delim = folders[0]?.delimiter || '/';
  const orderedNames = useMemo(() => {
    const names = (folderList ?? []).filter((f) => !f.name.includes(delim)).map((f) => f.name);
    const saved = orderQuery.data ?? [];
    const rank = new Map(saved.map((n, i) => [n, i]));
    return [...names].sort((a, b) => (rank.get(a) ?? 1000) - (rank.get(b) ?? 1000));
  }, [delim, folderList, orderQuery.data]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isNew) await accountsApi().create(form);
      else await accountsApi().update(id, form);
      await refreshSession();
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(null);
    try {
      setTestResult(await accountsApi().test(form));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('accounts.testFailed'));
    } finally {
      setBusy(false);
    }
  };

  const move = async (name: string, dir: -1 | 1) => {
    const idx = orderedNames.indexOf(name);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= orderedNames.length) return;
    const copy = [...orderedNames];
    [copy[idx], copy[next]] = [copy[next], copy[idx]];
    await accountsApi().setFolderOrder(id, copy);
    void queryClient.invalidateQueries({ queryKey: ['folderOrder', id] });
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={isNew ? t('accounts.add') : t('accounts.edit', { name: existing?.label || existing?.email || '' })} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <LabeledInput label={t('accounts.label')} value={form.label} onChangeText={(v) => set('label', v)} />
        <LabeledInput label={t('accounts.email')} value={form.email} onChangeText={(v) => set('email', v)} autoCapitalize="none" keyboardType="email-address" />
        <Text style={[styles.h, { color: colors.text }]}>{t('accounts.imap')}</Text>
        <LabeledInput label={t('accounts.host')} value={form.imapHost} onChangeText={(v) => set('imapHost', v)} autoCapitalize="none" />
        <LabeledInput label={t('accounts.port')} value={String(form.imapPort)} onChangeText={(v) => set('imapPort', parseInt(v, 10) || 993)} keyboardType="number-pad" />
        <SwitchRow label={t('accounts.useTls')} value={form.imapUseTls} onValueChange={(v) => set('imapUseTls', v)} />
        <SwitchRow label={t('accounts.allowInsecure')} value={!!form.imapAllowInsecureTls} onValueChange={(v) => set('imapAllowInsecureTls', v)} />
        <Text style={[styles.h, { color: colors.text }]}>{t('accounts.smtp')}</Text>
        <LabeledInput label={t('accounts.host')} value={form.smtpHost} onChangeText={(v) => set('smtpHost', v)} autoCapitalize="none" />
        <LabeledInput label={t('accounts.port')} value={String(form.smtpPort)} onChangeText={(v) => set('smtpPort', parseInt(v, 10) || 587)} keyboardType="number-pad" />
        <SwitchRow label={t('accounts.useTlsSmtp')} value={form.smtpUseTls} onValueChange={(v) => set('smtpUseTls', v)} />
        <SwitchRow label={t('accounts.allowInsecure')} value={!!form.smtpAllowInsecureTls} onValueChange={(v) => set('smtpAllowInsecureTls', v)} />
        <LabeledInput label={t('accounts.username')} value={form.username} onChangeText={(v) => set('username', v)} autoCapitalize="none" />
        <LabeledInput
          label={`${t('accounts.password')}${isNew ? '' : ` ${t('accounts.passwordKeep')}`}`}
          value={form.password || ''}
          onChangeText={(v) => set('password', v)}
          secureTextEntry
        />
        <Pressable accessibilityRole="button" onPress={() => setShowSieve((s) => !s)} style={{ minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: colors.primary }}>{t('accounts.sieveAdvanced')}</Text>
        </Pressable>
        {showSieve ? (
          <>
            <LabeledInput label={t('accounts.sieveHost')} value={form.sieveHost || ''} onChangeText={(v) => set('sieveHost', v)} autoCapitalize="none" />
            <LabeledInput label={t('accounts.sievePort')} value={String(form.sievePort || 4190)} onChangeText={(v) => set('sievePort', parseInt(v, 10) || 4190)} keyboardType="number-pad" />
            <SwitchRow label={t('accounts.useTlsSieve')} value={!!form.sieveUseTls} onValueChange={(v) => set('sieveUseTls', v)} />
            <SwitchRow label={t('accounts.allowInsecureSieve')} value={!!form.sieveAllowInsecureTls} onValueChange={(v) => set('sieveAllowInsecureTls', v)} />
          </>
        ) : null}
        {testResult ? (
          <Text style={{ color: colors.text }}>
            IMAP {testResult.imap} · SMTP {testResult.smtp}
          </Text>
        ) : null}
        {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
        <PrimaryButton label={t('accounts.test')} onPress={() => void test()} disabled={busy} />
        <PrimaryButton label={t('common.save')} onPress={() => void save()} disabled={busy} />

        {!isNew && existing ? (
          <>
            <Text style={[styles.h, { color: colors.text }]}>{t('folderManager.title')}</Text>
            <Text style={{ color: colors.textMuted }}>{t('folderManager.hint')}</Text>
            {folders.map((f) => {
              const visible = prefsQuery.data?.[f.name] ?? true;
              return (
                <View key={f.name} style={styles.folderRow}>
                  <Text style={{ color: colors.text, flex: 1 }}>{folderDisplayName(f.name, f.specialUse)}</Text>
                  <Switch
                    accessibilityLabel={t('folderManager.visible')}
                    value={visible}
                    onValueChange={(next) => {
                      void accountsApi()
                        .setFolderPref(id, f.name, next)
                        .then(() => queryClient.invalidateQueries({ queryKey: ['folderPrefs', id] }));
                    }}
                  />
                </View>
              );
            })}
            <Text style={[styles.h, { color: colors.text }]}>{t('folderManager.topLevelOrder')}</Text>
            {orderedNames.map((name) => (
              <View key={name} style={styles.folderRow}>
                <Text style={{ color: colors.text, flex: 1 }}>{folderDisplayName(name)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={t('folderManager.moveUp')} onPress={() => void move(name, -1)} style={styles.iconBtn}>
                  <Text style={{ color: colors.primary }}>↑</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={t('folderManager.moveDown')} onPress={() => void move(name, 1)} style={styles.iconBtn}>
                  <Text style={{ color: colors.primary }}>↓</Text>
                </Pressable>
              </View>
            ))}
            <PrimaryButton
              label={t('accounts.ensureJunk')}
              onPress={() => {
                void accountsApi()
                  .ensureJunkFolder(id)
                  .then(() => queryClient.invalidateQueries({ queryKey: ['folders', id] }));
              }}
            />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function SwitchRow({
  label,
  value,
  onValueChange,
}: {
  label: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const colors = useThemeTokens();
  return (
    <View style={styles.folderRow}>
      <Text style={{ color: colors.text, flex: 1 }}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={onValueChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 10, paddingBottom: 48 },
  h: { fontSize: 16, fontWeight: '700', marginTop: 8 },
  folderRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 8 },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});

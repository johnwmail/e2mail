import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { prefsApi } from '../../src/api';
import { LabeledInput } from '../../src/components/LabeledInput';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { useT } from '../../src/hooks/useT';
import { registerForPushAsync } from '../../src/push/register';
import { useMailboxStore } from '../../src/stores/useMailboxStore';
import { useThemeTokens } from '../../src/theme/useTheme';

export default function PushSettingsScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const accountId = useMailboxStore((s) => s.activeAccountId);
  const [enabled, setEnabled] = useState(true);
  const [quietStart, setQuietStart] = useState('');
  const [quietEnd, setQuietEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const api = prefsApi();
        const [en, start, end] = await Promise.all([
          api.get('pushEnabled'),
          api.get('pushQuietStart'),
          api.get('pushQuietEnd'),
        ]);
        if (en === 'false') setEnabled(false);
        if (start) setQuietStart(start);
        if (end) setQuietEnd(end);
      } catch {
        // keep defaults
      }
    })();
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      const api = prefsApi();
      await Promise.all([
        api.set('pushEnabled', enabled ? 'true' : 'false'),
        api.set('pushQuietStart', quietStart.trim()),
        api.set('pushQuietEnd', quietEnd.trim()),
      ]);
      if (enabled) {
        const token = await registerForPushAsync(accountId ? [accountId] : undefined);
        setStatus(token ? t('push.registered') : t('push.needDevice'));
      } else {
        setStatus(t('push.saved'));
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : t('error.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={{ color: colors.primary }}>{t('common.back')}</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>{t('push.title')}</Text>
        <View style={styles.back} />
      </View>
      <View style={styles.body}>
        <View style={[styles.row, { borderColor: colors.border }]}>
          <Text style={{ color: colors.text }}>{t('push.enabled')}</Text>
          <Switch value={enabled} onValueChange={setEnabled} />
        </View>
        <Text style={{ color: colors.textMuted }}>{t('push.quietHint')}</Text>
        <LabeledInput label={t('push.quietStart')} value={quietStart} onChangeText={setQuietStart} placeholder="22:00" />
        <LabeledInput label={t('push.quietEnd')} value={quietEnd} onChangeText={setQuietEnd} placeholder="07:00" />
        {status ? <Text style={{ color: colors.textMuted }}>{status}</Text> : null}
        <PrimaryButton label={t('common.save')} onPress={() => void save()} disabled={busy} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    minHeight: 48,
  },
  back: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  body: { padding: 16, gap: 12 },
  row: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});

import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { accountsApi } from '../../../src/api';
import { PrimaryButton } from '../../../src/components/PrimaryButton';
import { ScreenHeader } from '../../../src/components/ScreenHeader';
import { useT } from '../../../src/hooks/useT';
import { useAuthStore } from '../../../src/stores/useAuthStore';
import { useThemeTokens } from '../../../src/theme/useTheme';

export default function AccountsListScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const refreshSession = useAuthStore((s) => s.refreshSession);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['accounts'], queryFn: () => accountsApi().list() });

  const setDefault = async (id: string) => {
    await accountsApi().setDefault(id);
    await refreshSession();
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const remove = (id: string, name: string) => {
    Alert.alert(t('common.delete'), name, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void accountsApi()
            .remove(id)
            .then(() => refreshSession())
            .then(() => queryClient.invalidateQueries({ queryKey: ['accounts'] }));
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScreenHeader title={t('settings.accounts')} />
      <ScrollView contentContainerStyle={styles.body}>
        <PrimaryButton label={t('accounts.add')} onPress={() => router.push('/(app)/settings/account/new')} />
        {query.isError ? (
          <Pressable accessibilityRole="button" onPress={() => void query.refetch()}>
            <Text style={{ color: colors.danger }}>{t('error.retry')}</Text>
          </Pressable>
        ) : null}
        {(query.data ?? []).map((acc) => (
          <View key={acc.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.bgMuted }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('accounts.edit', { name: acc.label || acc.email })}
              onPress={() => router.push(`/(app)/settings/account/${acc.id}`)}
              style={{ flex: 1, minHeight: 44 }}
            >
              <Text style={{ color: colors.text, fontWeight: '700' }}>
                {acc.label || acc.email}
                {acc.isDefault ? ` · ${t('accounts.default')}` : ''}
              </Text>
              <Text style={{ color: colors.textMuted }}>{acc.email}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                {acc.imapHost}:{acc.imapPort}
              </Text>
            </Pressable>
            <View style={styles.actions}>
              {!acc.isDefault ? (
                <PrimaryButton label={t('accounts.setDefault')} onPress={() => void setDefault(acc.id)} />
              ) : null}
              <PrimaryButton label={t('common.delete')} danger onPress={() => remove(acc.id, acc.label || acc.email)} />
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 10 },
  actions: { gap: 8 },
});

import { folderDisplayName } from '@e2mail/shared';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { accountsApi, mailApi } from '../api';
import { useT } from '../hooks/useT';
import { isVisibleFolder, sortFolders, useMailboxStore } from '../stores/useMailboxStore';
import { useAuthStore } from '../stores/useAuthStore';
import { usePrefsStore } from '../stores/usePrefsStore';
import { useThemeTokens } from '../theme/useTheme';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PrimaryButton } from './PrimaryButton';

export function FolderDrawer() {
  const colors = useThemeTokens();
  const t = useT();
  const open = useMailboxStore((s) => s.folderDrawerOpen);
  const setOpen = useMailboxStore((s) => s.setFolderDrawerOpen);
  const session = useAuthStore((s) => s.session);
  const logout = useAuthStore((s) => s.logout);
  const apiBaseUrl = usePrefsStore((s) => s.apiBaseUrl);
  const listMode = usePrefsStore((s) => s.listMode);
  const setListMode = usePrefsStore((s) => s.setListMode);
  const theme = usePrefsStore((s) => s.theme);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const accountId = useMailboxStore((s) => s.activeAccountId);
  const setAccount = useMailboxStore((s) => s.setActiveAccountId);
  const setFolder = useMailboxStore((s) => s.setCurrentFolder);
  const setUnreadView = useMailboxStore((s) => s.setUnreadView);
  const currentFolder = useMailboxStore((s) => s.currentFolder);
  const queryClient = useQueryClient();

  const accounts = session?.accounts ?? [];
  const account = accounts.find((a) => a.id === accountId) ?? accounts[0];

  const foldersQuery = useQuery({
    queryKey: ['folders', account?.id],
    queryFn: () => mailApi().getFolders(account!.id),
    enabled: !!account,
  });

  const prefsQuery = useQuery({
    queryKey: ['folderPrefs', account?.id],
    queryFn: () => accountsApi().getFolderPrefs(account!.id),
    enabled: !!account,
  });

  const orderQuery = useQuery({
    queryKey: ['folderOrder', account?.id],
    queryFn: () => accountsApi().getFolderOrder(account!.id),
    enabled: !!account,
  });

  const visible = sortFolders(
    (foldersQuery.data ?? []).filter((f) => isVisibleFolder(f, prefsQuery.data)),
    orderQuery.data ?? []
  );

  return (
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.text }]}>{t('mail.folders')}</Text>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}>
            <Text style={{ color: colors.primary }}>{t('common.close')}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {accounts.map((a) => (
            <Pressable
              key={a.id}
              accessibilityRole="button"
              onPress={() => {
                setAccount(a.id);
                void queryClient.invalidateQueries({ queryKey: ['folders'] });
              }}
              style={[
                styles.row,
                {
                  borderColor: a.id === account?.id ? colors.primary : colors.border,
                  backgroundColor: colors.bgMuted,
                },
              ]}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>{a.label || a.email}</Text>
              <Text style={{ color: colors.textMuted, fontSize: 12 }}>{a.email}</Text>
            </Pressable>
          ))}

          <Pressable
            accessibilityRole="button"
            onPress={() => setUnreadView(true)}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text }}>{t('sidebar.allUnread')}</Text>
          </Pressable>

          {foldersQuery.isError ? (
            <Pressable onPress={() => void foldersQuery.refetch()}>
              <Text style={{ color: colors.danger }}>{t('mail.retry')}</Text>
            </Pressable>
          ) : null}

          {visible.map((folder) => (
            <Pressable
              key={folder.name}
              accessibilityRole="button"
              onPress={() => setFolder(folder.name)}
              style={[
                styles.row,
                {
                  borderColor: folder.name === currentFolder ? colors.primary : colors.border,
                },
              ]}
            >
              <Text style={{ color: colors.text, fontWeight: '600' }}>
                {folderDisplayName(folder.name, folder.specialUse)}
              </Text>
              {folder.unreadCount ? (
                <Text style={{ color: colors.primary }}>{folder.unreadCount}</Text>
              ) : null}
            </Pressable>
          ))}

          <Text style={[styles.section, { color: colors.textMuted }]}>{t('home.theme')}</Text>
          <View style={styles.chips}>
            {(['light', 'dark', 'system'] as const).map((opt) => (
              <Pressable
                key={opt}
                onPress={() => void setTheme(opt)}
                style={[
                  styles.chip,
                  { borderColor: theme === opt ? colors.primary : colors.border },
                ]}
              >
                <Text style={{ color: colors.text }}>{t(`home.theme.${opt}`)}</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            accessibilityRole="button"
            onPress={() => void setListMode(listMode === 'threads' ? 'messages' : 'threads')}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text }}>
              {listMode === 'threads' ? t('header.messagesMode') : t('header.threadsMode')}
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('settings.title')}
            onPress={() => {
              setOpen(false);
              router.push('/(app)/settings');
            }}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text }}>{t('settings.title')}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setOpen(false);
              router.push('/(app)/push');
            }}
            style={[styles.row, { borderColor: colors.border }]}
          >
            <Text style={{ color: colors.text }}>{t('push.title')}</Text>
          </Pressable>

          {__DEV__ ? (
            <Pressable
              onPress={() => {
                setOpen(false);
                router.push('/crypto-diagnostics');
              }}
              style={[styles.row, { borderColor: colors.border }]}
            >
              <Text style={{ color: colors.primary }}>Crypto diagnostics (dev)</Text>
            </Pressable>
          ) : null}

          {visible
            .filter((f) => f.specialUse === 'trash' || /trash|bin/i.test(f.name))
            .map((trash) => (
              <PrimaryButton
                key={trash.name}
                danger
                label={t('sidebar.emptyTrash')}
                onPress={() => {
                  Alert.alert(t('sidebar.emptyTrashTitle'), t('sidebar.emptyTrashConfirm', { name: trash.name }), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                      text: t('common.delete'),
                      style: 'destructive',
                      onPress: () => {
                        void mailApi()
                          .emptyFolder(trash.name, account?.id)
                          .then(() => queryClient.invalidateQueries({ queryKey: ['messages'] }));
                      },
                    },
                  ]);
                }}
              />
            ))}

          <PrimaryButton
            label={t('common.logout')}
            danger
            onPress={() => {
              setOpen(false);
              void logout(apiBaseUrl);
            }}
          />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: { fontSize: 20, fontWeight: '700' },
  close: { minHeight: 44, justifyContent: 'center' },
  body: { padding: 16, gap: 10 },
  row: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  section: { marginTop: 8, fontSize: 12, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, minHeight: 44 },
});

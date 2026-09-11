import { useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  folderDisplayName,
  formatShortDate,
  type MessageSummary,
  type ThreadSummary,
} from '@e2mail/shared';
import { accountsApi, mailApi } from '../../src/api';
import { FolderDrawer } from '../../src/components/FolderDrawer';
import { PrimaryButton } from '../../src/components/PrimaryButton';
import { useT } from '../../src/hooks/useT';
import { isVisibleFolder, sortFolders, useMailboxStore } from '../../src/stores/useMailboxStore';
import { usePrefsStore } from '../../src/stores/usePrefsStore';
import { useThemeTokens } from '../../src/theme/useTheme';

const PAGE = 50;

export default function MessageListScreen() {
  const colors = useThemeTokens();
  const t = useT();
  const accountId = useMailboxStore((s) => s.activeAccountId);
  const folder = useMailboxStore((s) => s.currentFolder);
  const unreadView = useMailboxStore((s) => s.unreadView);
  const setOpen = useMailboxStore((s) => s.setFolderDrawerOpen);
  const listMode = usePrefsStore((s) => s.listMode);

  const foldersQuery = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi().getFolders(accountId ?? undefined),
    enabled: !!accountId,
  });
  const prefsQuery = useQuery({
    queryKey: ['folderPrefs', accountId],
    queryFn: () => accountsApi().getFolderPrefs(accountId!),
    enabled: !!accountId,
  });
  const orderQuery = useQuery({
    queryKey: ['folderOrder', accountId],
    queryFn: () => accountsApi().getFolderOrder(accountId!),
    enabled: !!accountId,
  });

  const folderMeta = useMemo(() => {
    const folders = sortFolders(
      (foldersQuery.data ?? []).filter((f) => isVisibleFolder(f, prefsQuery.data)),
      orderQuery.data ?? []
    );
    return folders.find((f) => f.name === folder);
  }, [folder, foldersQuery.data, orderQuery.data, prefsQuery.data]);

  const listQuery = useInfiniteQuery({
    queryKey: ['messages', accountId, folder, unreadView, listMode],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      if (unreadView) return mailApi().getUnread(pageParam, PAGE, accountId ?? undefined);
      return mailApi().getMessages(
        folder,
        pageParam,
        PAGE,
        '',
        accountId ?? undefined,
        listMode === 'threads'
      );
    },
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: !!accountId,
  });

  const messages = listQuery.data?.pages.flatMap((p) => p.messages) ?? [];
  const threads = listQuery.data?.pages.flatMap((p) => p.threads ?? []) ?? [];
  const showThreads = listMode === 'threads' && !unreadView && threads.length > 0;

  const title = unreadView
    ? t('header.unread')
    : folderDisplayName(folder, folderMeta?.specialUse);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <View style={[styles.top, { borderBottomColor: colors.border }]}>
        <Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={styles.iconBtn}>
          <Text style={{ color: colors.primary }}>{t('header.openMenu')}</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/(app)/compose')}
          style={styles.iconBtn}
        >
          <Text style={{ color: colors.primary }}>{t('mail.compose')}</Text>
        </Pressable>
      </View>

      {listQuery.isError ? (
        <View style={styles.center}>
          <Text style={{ color: colors.danger }}>{(listQuery.error as Error).message}</Text>
          <PrimaryButton label={t('mail.retry')} onPress={() => void listQuery.refetch()} />
        </View>
      ) : showThreads ? (
        <FlatList
          data={threads}
          keyExtractor={(item) => item.threadId}
          onEndReached={() => {
            if (listQuery.hasNextPage) void listQuery.fetchNextPage();
          }}
          ListEmptyComponent={
            listQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
            ) : (
              <Text style={[styles.empty, { color: colors.textMuted }]}>{t('mail.empty')}</Text>
            )
          }
          renderItem={({ item }) => (
            <ThreadRow
              thread={item}
              onPress={() => {
                const uid = item.messages[0]?.uid;
                if (uid)
                  router.push({
                    pathname: '/(app)/message/[uid]',
                    params: { uid: String(uid), folder },
                  });
              }}
            />
          )}
        />
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(item) => `${item.folder ?? folder}:${item.uid}`}
          onEndReached={() => {
            if (listQuery.hasNextPage) void listQuery.fetchNextPage();
          }}
          ListEmptyComponent={
            listQuery.isLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
            ) : (
              <Text style={[styles.empty, { color: colors.textMuted }]}>{t('mail.empty')}</Text>
            )
          }
          renderItem={({ item }) => (
            <MessageRow
              msg={item}
              onPress={() =>
                router.push({
                  pathname: '/(app)/message/[uid]',
                  params: { uid: String(item.uid), folder: item.folder ?? folder },
                })
              }
            />
          )}
        />
      )}
      <FolderDrawer />
    </SafeAreaView>
  );
}

function MessageRow({ msg, onPress }: { msg: MessageSummary; onPress: () => void }) {
  const colors = useThemeTokens();
  const from = msg.from?.[0];
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, { borderBottomColor: colors.border, backgroundColor: colors.bg }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={{ color: colors.text, fontWeight: msg.unread ? '800' : '500' }}
        >
          {from?.name || from?.address || ''}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.text, fontWeight: msg.unread ? '700' : '400' }}>
          {msg.subject || '(no subject)'}
        </Text>
        <Text numberOfLines={1} style={{ color: colors.textMuted, fontSize: 13 }}>
          {msg.snippet || ''}
        </Text>
      </View>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {msg.date ? formatShortDate(new Date(msg.date)) : ''}
      </Text>
    </Pressable>
  );
}

function ThreadRow({ thread, onPress }: { thread: ThreadSummary; onPress: () => void }) {
  const colors = useThemeTokens();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, { borderBottomColor: colors.border }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.text, fontWeight: thread.unreadCount ? '800' : '500' }}>
          {thread.senders.join(', ')}
        </Text>
        <Text style={{ color: colors.text }} numberOfLines={1}>
          {thread.subject}
        </Text>
      </View>
      <Text style={{ color: colors.textMuted }}>{thread.messageCount}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    minHeight: 52,
  },
  title: { flex: 1, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  iconBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  row: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 72,
  },
  empty: { textAlign: 'center', marginTop: 48, paddingHorizontal: 24 },
  center: { padding: 24, gap: 12 },
});

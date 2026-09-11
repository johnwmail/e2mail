import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { parsePushData } from '@e2mail/shared';
import { useMailboxStore } from '../stores/useMailboxStore';
import { useAuthStore } from '../stores/useAuthStore';
import { registerForPushAsync } from '../push/register';
import { registerMailSyncTask } from '../push/tasks';

function openFromData(data: Record<string, unknown> | undefined) {
  const parsed = parsePushData(data);
  const mailbox = useMailboxStore.getState();
  if (parsed.accountId) mailbox.setActiveAccountId(parsed.accountId);
  mailbox.setCurrentFolder(parsed.folder);
  if (parsed.uid) {
    router.push({
      pathname: '/(app)/message/[uid]',
      params: { uid: String(parsed.uid), folder: parsed.folder },
    });
    return;
  }
  router.push('/(app)');
}

let handledInitialResponse = false;

export function usePushNotifications() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const accountId = useMailboxStore((s) => s.activeAccountId);

  useEffect(() => {
    if (!isAuthenticated || Platform.OS === 'web') return;
    void registerForPushAsync(accountId ? [accountId] : undefined);
    void registerMailSyncTask();
  }, [accountId, isAuthenticated]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      openFromData(data);
    });
    if (!handledInitialResponse) {
      handledInitialResponse = true;
      void Notifications.getLastNotificationResponseAsync().then((response) => {
        if (!response) return;
        const data = response.notification.request.content.data as Record<string, unknown> | undefined;
        openFromData(data);
      });
    }
    return () => sub.remove();
  }, []);
}

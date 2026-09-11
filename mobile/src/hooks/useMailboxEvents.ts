import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import EventSource from 'react-native-sse';
import { joinUrl, type MailboxEvent } from '@e2mail/shared';
import { getApiClient } from '../api';
import { useAuthStore } from '../stores/useAuthStore';
import { usePrefsStore } from '../stores/usePrefsStore';

export function useMailboxEvents() {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const apiBaseUrl = usePrefsStore((s) => s.apiBaseUrl);

  useEffect(() => {
    if (!isAuthenticated) return;
    let closed = false;
    let source: EventSource<'mailbox_event'> | null = null;

    void (async () => {
      const token = await getApiClient().getToken();
      if (!token || closed) return;
      const url = joinUrl(apiBaseUrl, '/api/events');
      source = new EventSource(url, {
        headers: { 'X-Session-ID': token, Accept: 'text/event-stream' },
      });
      source.addEventListener('mailbox_event', (event) => {
        if (!('data' in event) || !event.data) return;
        try {
          const parsed = JSON.parse(event.data) as MailboxEvent;
          if (parsed.type === 'NEW_MESSAGE' || parsed.type === 'FLAG_UPDATE' || parsed.type === 'EXPUNGE') {
            void queryClient.invalidateQueries({ queryKey: ['messages'] });
            void queryClient.invalidateQueries({ queryKey: ['folders'] });
          }
        } catch {
          // ignore malformed frames
        }
      });
    })();

    return () => {
      closed = true;
      source?.close();
    };
  }, [apiBaseUrl, isAuthenticated, queryClient]);
}

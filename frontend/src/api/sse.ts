import { MailboxEvent } from '../types/api';

export function connectEvents(onEvent: (evt: MailboxEvent) => void): () => void {
  const url = '/api/events';
  const eventSource = new EventSource(url);

  eventSource.addEventListener('mailbox_event', (e) => {
    try {
      const parsed: MailboxEvent = JSON.parse(e.data);
      onEvent(parsed);
    } catch (err) {
      console.error('Failed to parse SSE mailbox_event:', err);
    }
  });

  eventSource.onerror = (err) => {
    console.warn('SSE connection error, browser will automatically retry...', err);
  };

  return () => {
    eventSource.close();
  };
}

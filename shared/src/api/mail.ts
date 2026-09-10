import type { ApiClient } from './client';
import { ApiError } from './client';
import type { FolderInfo, MessageListResult, OutgoingMessage, ParsedMessage } from '../types/api';

function accountParam(account?: string): string {
  return account ? `?account=${encodeURIComponent(account)}` : '';
}

export function createMailApi(client: ApiClient) {
  return {
    getFolders: (account?: string): Promise<FolderInfo[]> =>
      client.request(`/mail/folders?x=1${accountParam(account).replace('?', '&')}`),

    getMessages: (
      folder = 'INBOX',
      page = 1,
      limit = 50,
      query = '',
      account?: string,
      thread = false
    ): Promise<MessageListResult> => {
      const params = new URLSearchParams({
        folder,
        page: page.toString(),
        limit: limit.toString(),
      });
      if (query) params.set('q', query);
      if (account) params.set('account', account);
      if (thread) params.set('thread', '1');
      return client.request(`/mail/messages?${params.toString()}`);
    },

    getUnread: (page = 1, limit = 50, account?: string): Promise<MessageListResult> => {
      const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
      if (account) params.set('account', account);
      return client.request(`/mail/unread?${params.toString()}`);
    },

    getMessageDetail: (uid: number, folder = 'INBOX', account?: string): Promise<ParsedMessage> => {
      const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
      return client.request(
        `/mail/messages/${uid}?folder=${encodeURIComponent(folder)}${accountQS}`
      );
    },

    getAttachmentPath: (uid: number, attId: string, folder = 'INBOX', account?: string): string => {
      const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
      return `/mail/messages/${uid}/attachments/${encodeURIComponent(attId)}?folder=${encodeURIComponent(folder)}${accountQS}`;
    },

    getRawMessage: async (uid: number, folder = 'INBOX', account?: string): Promise<string> => {
      const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
      const res = await client.raw(
        `/mail/messages/${uid}/raw?folder=${encodeURIComponent(folder)}${accountQS}`
      );
      if (!res.ok) {
        throw new ApiError(
          client.translate('api.rawMailFailed', { status: res.status }),
          res.status
        );
      }
      return res.text();
    },

    setFlags: (
      folder: string,
      uids: number[],
      flags: string[],
      op: 'add' | 'remove' | 'set',
      account?: string
    ): Promise<void> =>
      client.request(`/mail/messages/flags${accountParam(account)}`, {
        method: 'POST',
        body: JSON.stringify({ folder, uids, flags, op }),
      }),

    moveMessages: (
      folder: string,
      uids: number[],
      destFolder: string,
      account?: string
    ): Promise<void> =>
      client.request(`/mail/messages/move${accountParam(account)}`, {
        method: 'POST',
        body: JSON.stringify({ folder, uids, destFolder }),
      }),

    deleteMessages: (
      folder: string,
      uids: number[],
      permanent = false,
      account?: string
    ): Promise<void> =>
      client.request(`/mail/messages/delete${accountParam(account)}`, {
        method: 'POST',
        body: JSON.stringify({ folder, uids, permanent }),
      }),

    emptyFolder: (folder: string, account?: string): Promise<void> =>
      client.request(`/mail/messages/empty${accountParam(account)}`, {
        method: 'POST',
        body: JSON.stringify({ folder }),
      }),

    sendMessage: (msg: OutgoingMessage, account?: string): Promise<void> =>
      postOutgoing(client, `/mail/send${accountParam(account)}`, msg, account),

    saveDraft: (msg: OutgoingMessage, account?: string): Promise<void> =>
      postOutgoing(client, `/mail/drafts${accountParam(account)}`, msg, account),
  };
}

function postOutgoing(
  client: ApiClient,
  path: string,
  msg: OutgoingMessage,
  account?: string
): Promise<void> {
  if (msg.attachments && msg.attachments.length > 0) {
    const formData = new FormData();
    if (msg.from) formData.append('from', msg.from);
    formData.append('to', (msg.to || []).join(','));
    if (msg.cc) formData.append('cc', msg.cc.join(','));
    if (msg.bcc) formData.append('bcc', msg.bcc.join(','));
    formData.append('subject', msg.subject || '');
    if (msg.inReplyTo) formData.append('inReplyTo', msg.inReplyTo);
    if (msg.references) formData.append('references', msg.references);
    if (msg.textBody) formData.append('textBody', msg.textBody);
    if (msg.htmlBody) formData.append('htmlBody', msg.htmlBody);
    if (account) formData.append('account', account);
    msg.attachments.forEach((file) => {
      formData.append('attachments', file);
    });
    return client.request(path, { method: 'POST', body: formData });
  }
  return client.request(path, {
    method: 'POST',
    body: JSON.stringify(msg),
  });
}

export type MailApi = ReturnType<typeof createMailApi>;

import { request } from './client';
import { t } from '../i18n';
import {
  FolderInfo,
  MessageListResult,
  OutgoingMessage,
  ParsedMessage,
} from '../types/api';

const accountParam = (account?: string): string =>
  account ? `?account=${encodeURIComponent(account)}` : '';

export const mailApi = {
  getFolders: async (account?: string): Promise<FolderInfo[]> => {
    return request<FolderInfo[]>(`/mail/folders?x=1${accountParam(account).replace('?', '&')}`);
  },

  setFolderSubscription: async (
    name: string,
    subscribed: boolean,
    account?: string
  ): Promise<{ subscribed: boolean }> => {
    return request<{ subscribed: boolean }>(`/mail/folders/subscribe${accountParam(account)}`, {
      method: 'POST',
      body: JSON.stringify({ name, subscribed }),
    });
  },

  getMessages: async (
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
    if (query) {
      params.set('q', query);
    }
    if (account) {
      params.set('account', account);
    }
    if (thread) {
      params.set('thread', '1');
    }
    return request<MessageListResult>(`/mail/messages?${params.toString()}`);
  },

  getUnread: async (page = 1, limit = 50, account?: string): Promise<MessageListResult> => {
    const params = new URLSearchParams({ page: page.toString(), limit: limit.toString() });
    if (account) {
      params.set('account', account);
    }
    return request<MessageListResult>(`/mail/unread?${params.toString()}`);
  },

  getMessageDetail: async (
    uid: number,
    folder = 'INBOX',
    account?: string
  ): Promise<ParsedMessage> => {
    const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
    return request<ParsedMessage>(`/mail/messages/${uid}?folder=${encodeURIComponent(folder)}${accountQS}`);
  },

  getAttachmentUrl: (uid: number, attId: string, folder = 'INBOX', account?: string): string => {
    const token = localStorage.getItem('e2Mail_token') || '';
    const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
    return `/api/mail/messages/${uid}/attachments/${encodeURIComponent(attId)}?folder=${encodeURIComponent(folder)}&token=${encodeURIComponent(token)}${accountQS}`;
  },

  getRawMessage: async (uid: number, folder = 'INBOX', account?: string): Promise<string> => {
    const token = localStorage.getItem('e2Mail_token') || '';
    const accountQS = account ? `&account=${encodeURIComponent(account)}` : '';
    const url = `/api/mail/messages/${uid}/raw?folder=${encodeURIComponent(folder)}${accountQS}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!res.ok) {
      throw new Error(t('api.rawMailFailed', { status: res.status }));
    }
    return res.text();
  },

  setFlags: async (
    folder: string,
    uids: number[],
    flags: string[],
    op: 'add' | 'remove' | 'set',
    account?: string
  ): Promise<void> => {
    return request<void>(`/mail/messages/flags${accountParam(account)}`, {
      method: 'POST',
      body: JSON.stringify({ folder, uids, flags, op }),
    });
  },

  moveMessages: async (
    folder: string,
    uids: number[],
    destFolder: string,
    account?: string
  ): Promise<void> => {
    return request<void>(`/mail/messages/move${accountParam(account)}`, {
      method: 'POST',
      body: JSON.stringify({ folder, uids, destFolder }),
    });
  },

  deleteMessages: async (
    folder: string,
    uids: number[],
    permanent = false,
    account?: string
  ): Promise<void> => {
    return request<void>(`/mail/messages/delete${accountParam(account)}`, {
      method: 'POST',
      body: JSON.stringify({ folder, uids, permanent }),
    });
  },

  emptyFolder: async (folder: string, account?: string): Promise<void> => {
    return request<void>(`/mail/messages/empty${accountParam(account)}`, {
      method: 'POST',
      body: JSON.stringify({ folder }),
    });
  },

  sendMessage: async (msg: OutgoingMessage, account?: string): Promise<void> => {
    return postOutgoing(`/mail/send${accountParam(account)}`, msg, account);
  },

  saveDraft: async (msg: OutgoingMessage, account?: string): Promise<void> => {
    return postOutgoing(`/mail/drafts${accountParam(account)}`, msg, account);
  },
};

function postOutgoing(path: string, msg: OutgoingMessage, account?: string): Promise<void> {
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
    return request<void>(path, { method: 'POST', body: formData });
  }
  return request<void>(path, {
    method: 'POST',
    body: JSON.stringify(msg),
  });
}

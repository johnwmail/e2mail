import { request } from './client';
import {
  FolderInfo,
  MessageListResult,
  OutgoingMessage,
  ParsedMessage,
} from '../types/api';

export const mailApi = {
  getFolders: async (): Promise<FolderInfo[]> => {
    return request<FolderInfo[]>('/mail/folders');
  },

  setFolderSubscription: async (
    name: string,
    subscribed: boolean
  ): Promise<{ subscribed: boolean }> => {
    return request<{ subscribed: boolean }>('/mail/folders/subscribe', {
      method: 'POST',
      body: JSON.stringify({ name, subscribed }),
    });
  },

  getMessages: async (
    folder = 'INBOX',
    page = 1,
    limit = 50,
    query = ''
  ): Promise<MessageListResult> => {
    const params = new URLSearchParams({
      folder,
      page: page.toString(),
      limit: limit.toString(),
    });
    if (query) {
      params.set('q', query);
    }
    return request<MessageListResult>(`/mail/messages?${params.toString()}`);
  },

  getMessageDetail: async (
    uid: number,
    folder = 'INBOX'
  ): Promise<ParsedMessage> => {
    return request<ParsedMessage>(`/mail/messages/${uid}?folder=${encodeURIComponent(folder)}`);
  },

  getAttachmentUrl: (uid: number, attId: string, folder = 'INBOX'): string => {
    const token = localStorage.getItem('webmail_token') || '';
    return `/api/mail/messages/${uid}/attachments/${encodeURIComponent(attId)}?folder=${encodeURIComponent(folder)}&token=${encodeURIComponent(token)}`;
  },

  setFlags: async (
    folder: string,
    uids: number[],
    flags: string[],
    op: 'add' | 'remove' | 'set'
  ): Promise<void> => {
    return request<void>('/mail/messages/flags', {
      method: 'POST',
      body: JSON.stringify({ folder, uids, flags, op }),
    });
  },

  moveMessages: async (
    folder: string,
    uids: number[],
    destFolder: string
  ): Promise<void> => {
    return request<void>('/mail/messages/move', {
      method: 'POST',
      body: JSON.stringify({ folder, uids, destFolder }),
    });
  },

  deleteMessages: async (
    folder: string,
    uids: number[],
    permanent = false
  ): Promise<void> => {
    return request<void>('/mail/messages/delete', {
      method: 'POST',
      body: JSON.stringify({ folder, uids, permanent }),
    });
  },

  sendMessage: async (msg: OutgoingMessage): Promise<void> => {
    if (msg.attachments && msg.attachments.length > 0) {
      const formData = new FormData();
      if (msg.from) formData.append('from', msg.from);
      formData.append('to', msg.to.join(','));
      if (msg.cc) formData.append('cc', msg.cc.join(','));
      if (msg.bcc) formData.append('bcc', msg.bcc.join(','));
      formData.append('subject', msg.subject);
      if (msg.inReplyTo) formData.append('inReplyTo', msg.inReplyTo);
      if (msg.references) formData.append('references', msg.references);
      if (msg.textBody) formData.append('textBody', msg.textBody);
      if (msg.htmlBody) formData.append('htmlBody', msg.htmlBody);

      msg.attachments.forEach((file) => {
        formData.append('attachments', file);
      });

      return request<void>('/mail/send', {
        method: 'POST',
        body: formData,
      });
    }

    return request<void>('/mail/send', {
      method: 'POST',
      body: JSON.stringify(msg),
    });
  },
};

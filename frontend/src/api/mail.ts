import { createMailApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

const api = createMailApi(getBrowserClient());

export const mailApi = {
  ...api,
  getAttachmentUrl: (
    uid: number,
    attId: string,
    folder = 'INBOX',
    account?: string
  ): string => `/api${api.getAttachmentPath(uid, attId, folder, account)}`,
};

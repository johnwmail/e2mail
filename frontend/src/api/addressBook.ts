import { createContactsApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

const api = createContactsApi(getBrowserClient());

export type { Contact } from '@e2mail/shared';

export const contactsApi = {
  ...api,
  getAvatarUrl: (id: string): string => `/api${api.getAvatarPath(id)}`,
  fetchAvatarBlob: async (id: string): Promise<string | null> => {
    const blob = await api.fetchAvatarBlob(id);
    if (!blob) return null;
    return URL.createObjectURL(blob);
  },
  exportContacts: async (format: 'csv' | 'vcf' = 'csv'): Promise<void> => {
    const { blob, filename } = await api.exportContacts(format);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

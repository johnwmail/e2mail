import type { ApiClient } from './client';
import { ApiError } from './client';

export interface Contact {
  id: string;
  email: string;
  displayName: string;
  givenName?: string;
  familyName?: string;
  hasAvatar: boolean;
  note?: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export function createContactsApi(client: ApiClient) {
  return {
    list: (q?: string, limit?: number, offset?: number): Promise<Contact[]> => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (limit) params.set('limit', String(limit));
      if (offset) params.set('offset', String(offset));
      const qs = params.toString() ? `?${params.toString()}` : '';
      return client.request(`/contacts/${qs}`);
    },

    get: (id: string): Promise<Contact> =>
      client.request(`/contacts/${encodeURIComponent(id)}`),

    create: (data: {
      email: string;
      displayName?: string;
      note?: string;
      givenName?: string;
      familyName?: string;
      source?: string;
    }): Promise<Contact> =>
      client.request('/contacts/', { method: 'POST', body: JSON.stringify(data) }),

    update: (
      id: string,
      data: Partial<Pick<Contact, 'email' | 'displayName' | 'note' | 'givenName' | 'familyName'>>
    ): Promise<Contact> =>
      client.request(`/contacts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),

    remove: (id: string): Promise<void> =>
      client.request(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    fromEmail: (email: string, displayName?: string, note?: string): Promise<Contact> =>
      client.request('/contacts/from-email', {
        method: 'POST',
        body: JSON.stringify({ email, displayName, note }),
      }),

    resolve: async (emails: string[]): Promise<Record<string, Contact>> => {
      if (emails.length === 0) return {};
      const qs = `?emails=${encodeURIComponent(emails.join(','))}`;
      return client.request(`/contacts/resolve${qs}`);
    },

    getAvatarPath: (id: string): string => `/contacts/${encodeURIComponent(id)}/avatar`,

    fetchAvatarBlob: async (id: string): Promise<Blob | null> => {
      try {
        const res = await client.raw(`/contacts/${encodeURIComponent(id)}/avatar`);
        if (!res.ok) return null;
        return res.blob();
      } catch {
        return null;
      }
    },

    uploadAvatar: async (id: string, file: Blob): Promise<Contact> => {
      const form = new FormData();
      form.append('file', file);
      const res = await client.raw(`/contacts/${encodeURIComponent(id)}/avatar`, {
        method: 'PUT',
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new ApiError(text || `upload failed: ${res.status}`, res.status);
      }
      const json = (await res.json()) as { data: Contact };
      return json.data;
    },

    deleteAvatar: (id: string): Promise<void> =>
      client.request(`/contacts/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' }),

    importContacts: async (
      file: Blob,
      mode: 'skip' | 'overwrite' = 'skip'
    ): Promise<{ saved: number; skipped: string[]; invalid: number }> => {
      const form = new FormData();
      form.append('file', file);
      const res = await client.raw(`/contacts/import?mode=${mode}`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new ApiError(text || `import failed: ${res.status}`, res.status);
      }
      const json = (await res.json()) as {
        data: { saved: number; skipped: string[]; invalid: number };
      };
      return json.data;
    },

    exportContacts: async (format: 'csv' | 'vcf' = 'csv'): Promise<{ blob: Blob; filename: string }> => {
      const res = await client.raw(`/contacts/export?format=${format}`);
      if (!res.ok) throw new ApiError(`export failed: ${res.status}`, res.status);
      const blob = await res.blob();
      return { blob, filename: format === 'vcf' ? 'contacts.vcf' : 'contacts.csv' };
    },
  };
}

export type ContactsApi = ReturnType<typeof createContactsApi>;

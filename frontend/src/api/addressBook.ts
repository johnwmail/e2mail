import { request } from './client';

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

export const contactsApi = {
  list: async (q?: string, limit?: number, offset?: number): Promise<Contact[]> => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    if (offset) params.set('offset', String(offset));
    const qs = params.toString() ? `?${params.toString()}` : '';
    return request<Contact[]>(`/contacts/${qs}`);
  },

  get: async (id: string): Promise<Contact> => {
    return request<Contact>(`/contacts/${encodeURIComponent(id)}`);
  },

  create: async (data: { email: string; displayName?: string; note?: string; givenName?: string; familyName?: string; source?: string }): Promise<Contact> => {
    return request<Contact>('/contacts/', { method: 'POST', body: JSON.stringify(data) });
  },

  update: async (id: string, data: Partial<Pick<Contact, 'email' | 'displayName' | 'note' | 'givenName' | 'familyName'>>): Promise<Contact> => {
    return request<Contact>(`/contacts/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(data) });
  },

  remove: async (id: string): Promise<void> => {
    await request<void>(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  fromEmail: async (email: string, displayName?: string, note?: string): Promise<Contact> => {
    return request<Contact>('/contacts/from-email', { method: 'POST', body: JSON.stringify({ email, displayName, note }) });
  },

  resolve: async (emails: string[]): Promise<Record<string, Contact>> => {
    if (emails.length === 0) return {};
    const qs = `?emails=${encodeURIComponent(emails.join(','))}`;
    return request<Record<string, Contact>>(`/contacts/resolve${qs}`);
  },

  getAvatarUrl: (id: string): string => {
    // Session 憑證係 same-origin HttpOnly cookie，<img src> 會自動帶上。
    return `/api/contacts/${encodeURIComponent(id)}/avatar`;
  },

  fetchAvatarBlob: async (id: string): Promise<string | null> => {
    try {
      const res = await fetch(`/api/contacts/${encodeURIComponent(id)}/avatar`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  },

  uploadAvatar: async (id: string, file: File): Promise<Contact> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/contacts/${encodeURIComponent(id)}/avatar`, {
      method: 'PUT',
      credentials: 'same-origin',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `upload failed: ${res.status}`);
    }
    const json = await res.json();
    return json.data as Contact;
  },

  deleteAvatar: async (id: string): Promise<void> => {
    await request<void>(`/contacts/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' });
  },

  importContacts: async (file: File, mode: 'skip' | 'overwrite' = 'skip'): Promise<{ saved: number; skipped: string[]; invalid: number }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/contacts/import?mode=${mode}`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `import failed: ${res.status}`);
    }
    const json = await res.json();
    return json.data as { saved: number; skipped: string[]; invalid: number };
  },

  exportContacts: async (format: 'csv' | 'vcf' = 'csv'): Promise<void> => {
    const res = await fetch(`/api/contacts/export?format=${format}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`export failed: ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = format === 'vcf' ? 'contacts.vcf' : 'contacts.csv';
    a.click();
    URL.revokeObjectURL(url);
  },
};

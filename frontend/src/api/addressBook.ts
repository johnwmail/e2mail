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

  create: async (data: { email: string; displayName?: string; note?: string; givenName?: string; familyName?: string }): Promise<Contact> => {
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
    // 直接用 fetch，需附 Authorization header 時由 <img> 無法帶，改用 token query？現階段後端需鑑權，
    // 暫用 relative path 並靠 cookie/session？e2mail 用 Bearer token 存 localStorage，
    // 圖片需以 blob fetch。提供 helper 由呼叫方自行 fetch blob。
    return `/api/contacts/${encodeURIComponent(id)}/avatar`;
  },

  fetchAvatarBlob: async (id: string): Promise<string | null> => {
    try {
      const token = localStorage.getItem('webmail_token');
      const res = await fetch(`/api/contacts/${encodeURIComponent(id)}/avatar`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  },

  uploadAvatar: async (id: string, file: File): Promise<Contact> => {
    const token = localStorage.getItem('webmail_token');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api/contacts/${encodeURIComponent(id)}/avatar`, {
      method: 'PUT',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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
};

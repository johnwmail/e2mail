import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Search, Upload, Download, Trash2, Edit2, UserPlus, Users, Image as ImageIcon, X } from 'lucide-react';
import { contactsApi, Contact } from '../../api/addressBook';
import { useMailStore } from '../../stores/useMailStore';
import { toast } from '../../stores/useToastStore';
import { useI18n } from '../../i18n';

const ContactAvatar: React.FC<{ contact: Contact }> = ({ contact }) => {
  const [url, setUrl] = useState<string | null>(null);
  React.useEffect(() => {
    if (!contact.hasAvatar) return;
    let alive = true;
    contactsApi.fetchAvatarBlob(contact.id).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [contact.id, contact.hasAvatar]);
  if (url) return <img src={url} alt={contact.displayName} className="w-10 h-10 rounded-full object-cover shrink-0" />;
  const initial = (contact.displayName?.[0] || contact.email?.[0] || '?').toUpperCase();
  return <div className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-sm shrink-0">{initial}</div>;
};

export const ContactsPage: React.FC = () => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const setView = useMailStore((s) => s.setView);
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [editing, setEditing] = useState<Contact | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', email: '', note: '' });
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ email: '', displayName: '', note: '' });
  const [importMode, setImportMode] = useState<'skip' | 'overwrite'>('skip');
  const [importResult, setImportResult] = useState<{ saved: number; skipped: string[]; invalid: number } | null>(null);

  const { data: contacts, isLoading } = useQuery({
    queryKey: ['contacts', q],
    queryFn: () => contactsApi.list(q || undefined),
    staleTime: 10000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => contactsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast(t('contacts.deleted'));
    },
  });

  const updateMutation = useMutation({
    mutationFn: () => contactsApi.update(editing!.id, { displayName: editForm.displayName, email: editForm.email, note: editForm.note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setEditing(null);
      toast(t('contacts.updated'));
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      contactsApi.create({
        email: createForm.email.trim(),
        displayName: createForm.displayName.trim(),
        note: createForm.note.trim(),
        source: 'manual',
      }),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setCreating(false);
      setCreateForm({ email: '', displayName: '', note: '' });
      toast(t('contacts.added', { name: c.displayName }));
    },
    onError: (err: any) => {
      const msg = String(err?.message || err);
      toast(/already exists/i.test(msg) ? t('contacts.exists') : t('contacts.addFailed', { error: msg }));
    },
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const email = createForm.email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      toast(t('contacts.needEmail'));
      return;
    }
    createMutation.mutate();
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQ(searchInput.trim());
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await contactsApi.importContacts(file, importMode);
      setImportResult(res);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast(t('contacts.importDone', { saved: res.saved, skipped: res.skipped.length, invalid: res.invalid }));
    } catch (err: any) {
      toast(t('contacts.importFailed', { error: err?.message || String(err) }));
    }
    e.target.value = '';
  };

  const handleExport = (format: 'csv' | 'vcf') => {
    contactsApi.exportContacts(format).catch((err: any) => toast(t('contacts.exportFailed', { error: err?.message || String(err) })));
  };

  const openEdit = (c: Contact) => {
    setEditing(c);
    setEditForm({ displayName: c.displayName, email: c.email, note: c.note || '' });
  };

  const handleAvatarUpload = async (c: Contact, file: File) => {
    try {
      await contactsApi.uploadAvatar(c.id, file);
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      toast(t('contacts.avatarUpdated'));
    } catch (e: any) {
      toast(t('contacts.avatarFailed', { error: e?.message || String(e) }));
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
      <div className="h-14 border-b border-slate-200 dark:border-slate-800 px-3 md:px-4 flex items-center gap-2 shrink-0">
        <button onClick={() => setView('mail')} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Users className="w-5 h-5 text-blue-600" />
        <h1 className="font-bold text-sm md:text-base flex-1">{t('contacts.title')}</h1>
        <span className="text-xs text-slate-400">{t('contacts.count', { count: contacts?.length ?? 0 })}</span>
      </div>

      <div className="p-3 md:p-4 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row gap-2 shrink-0">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('contacts.searchPlaceholder')} className="w-full pl-9 pr-3 py-2 text-sm bg-slate-100 dark:bg-slate-800 rounded-lg outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <button type="submit" className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold">{t('common.search')}</button>
        </form>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setCreateForm({ email: '', displayName: '', note: '' }); setCreating(true); }}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold"
          >
            <UserPlus className="w-3.5 h-3.5" /> {t('common.add')}
          </button>
          <label className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 rounded-lg text-xs font-semibold cursor-pointer">
            <Upload className="w-3.5 h-3.5" /> {t('contacts.import')}
            <input type="file" accept=".csv,.vcf,.vcard" onChange={handleImport} className="hidden" />
          </label>
          <select value={importMode} onChange={(e) => setImportMode(e.target.value as any)} className="text-xs border rounded-lg px-1.5 py-2 bg-white dark:bg-slate-800">
            <option value="skip">{t('contacts.skipDuplicates')}</option>
            <option value="overwrite">{t('contacts.overwriteDuplicates')}</option>
          </select>
          <div className="flex gap-1">
            <button onClick={() => handleExport('csv')} className="px-2.5 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg text-xs font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" />CSV</button>
            <button onClick={() => handleExport('vcf')} className="px-2.5 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-semibold flex items-center gap-1"><Download className="w-3.5 h-3.5" />vCard</button>
          </div>
        </div>
      </div>

      {importResult && (
        <div className="mx-3 mt-2 p-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800 flex items-center justify-between">
          <span>{t('contacts.importDetails', { saved: importResult.saved, skipped: importResult.skipped.length, list: importResult.skipped.slice(0,3).join(', '), more: importResult.skipped.length > 3 ? '…' : '', invalid: importResult.invalid })}</span>
          <button onClick={() => setImportResult(null)} className="p-1 hover:bg-amber-100 rounded"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-slate-400">{t('common.loading')}</div>
        ) : !contacts || contacts.length === 0 ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center gap-2">
            <UserPlus className="w-10 h-10 text-slate-300" />
            <p className="text-xs">{t('contacts.empty')}</p>
          </div>
        ) : (
          contacts.map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-3 md:px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/50">
              <ContactAvatar contact={c} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{c.displayName}</div>
                <div className="text-xs text-slate-500 truncate">{c.email}</div>
                {c.note && <div className="text-[11px] text-slate-400 truncate">{c.note}</div>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <label className="p-1.5 hover:bg-slate-200 rounded-lg cursor-pointer text-slate-500" title={t('contacts.uploadAvatar')}>
                  <ImageIcon className="w-4 h-4" />
                  <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" onChange={(e) => e.target.files?.[0] && handleAvatarUpload(c, e.target.files[0])} className="hidden" />
                </label>
                <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-500"><Edit2 className="w-4 h-4" /></button>
                <button onClick={() => deleteMutation.mutate(c.id)} className="p-1.5 hover:bg-red-50 text-slate-400 hover:text-red-600 rounded-lg"><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          ))
        )}
      </div>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm" onClick={() => setCreating(false)}>
          <form
            onSubmit={handleCreateSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl p-4 space-y-3 border border-slate-200 dark:border-slate-800 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-sm">{t('contacts.addContact')}</h3>
              <button type="button" onClick={() => setCreating(false)} className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg text-slate-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="email"
              inputMode="email"
              autoFocus
              required
              value={createForm.email}
              onChange={(e) => setCreateForm((s) => ({ ...s, email: e.target.value }))}
              placeholder={t('contacts.emailRequired')}
              className="w-full px-3 py-2 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              value={createForm.displayName}
              onChange={(e) => setCreateForm((s) => ({ ...s, displayName: e.target.value }))}
              placeholder={t('contacts.displayNameHint')}
              className="w-full px-3 py-2 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            />
            <textarea
              value={createForm.note}
              onChange={(e) => setCreateForm((s) => ({ ...s, note: e.target.value }))}
              placeholder={t('contacts.notes')}
              className="w-full px-3 py-2 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              rows={2}
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCreating(false)} className="px-3 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 rounded-lg">{t('common.cancel')}</button>
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="px-4 py-2 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold disabled:opacity-50"
              >
                {createMutation.isPending ? t('contacts.adding') : t('common.add')}
              </button>
            </div>
          </form>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-xl p-4 space-y-3">
            <h3 className="font-bold text-sm">{t('contacts.editContact')}</h3>
            <input value={editForm.displayName} onChange={(e) => setEditForm((s) => ({ ...s, displayName: e.target.value }))} placeholder={t('contacts.displayName')} className="w-full px-3 py-2 text-sm border rounded-lg" />
            <input value={editForm.email} onChange={(e) => setEditForm((s) => ({ ...s, email: e.target.value }))} placeholder="Email" className="w-full px-3 py-2 text-sm border rounded-lg" />
            <textarea value={editForm.note} onChange={(e) => setEditForm((s) => ({ ...s, note: e.target.value }))} placeholder={t('contacts.notes')} className="w-full px-3 py-2 text-sm border rounded-lg" rows={3} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-xs bg-slate-100 rounded-lg">{t('common.cancel')}</button>
              <button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg disabled:opacity-50">{updateMutation.isPending ? t('common.saving') : t('common.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

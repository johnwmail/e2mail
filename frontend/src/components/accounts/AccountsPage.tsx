import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  Star,
  Loader2,
  CheckCircle2,
  XCircle,
  Settings2,
  UserRound,
} from 'lucide-react';
import { accountsApi, AccountInput } from '../../api/accounts';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { Account } from '../../types/api';

const emptyForm: AccountInput = {
  label: '',
  email: '',
  imapHost: '',
  imapPort: 993,
  imapUseTls: true,
  imapAllowInsecureTls: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUseTls: true,
  smtpAllowInsecureTls: false,
  username: '',
  password: '',
};

const inputCls =
  'w-full px-3 py-2 text-sm bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400';
const labelCls = 'text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-0.5';

const AccountsForm: React.FC<{
  existing?: Account | null;
  onDone: () => void;
}> = ({ existing, onDone }) => {
  const queryClient = useQueryClient();
  const isEdit = !!existing;
  const [form, setForm] = useState<AccountInput>(
    existing
      ? {
          label: existing.label,
          email: existing.email,
          imapHost: existing.imapHost,
          imapPort: existing.imapPort,
          imapUseTls: existing.imapUseTls,
          imapAllowInsecureTls: existing.imapAllowInsecureTls,
          smtpHost: existing.smtpHost,
          smtpPort: existing.smtpPort,
          smtpUseTls: existing.smtpUseTls,
          smtpAllowInsecureTls: existing.smtpAllowInsecureTls,
          username: existing.username,
          password: '',
        }
      : emptyForm
  );
  const [testResult, setTestResult] = useState<{ imap: string; smtp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const set = <K extends keyof AccountInput>(key: K, value: AccountInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleTest = async () => {
    if (!form.imapHost || !form.smtpHost || !form.password) {
      setError('請先填寫伺服器與密碼再測試連線');
      return;
    }
    setTesting(true);
    setError(null);
    try {
      const res = await accountsApi.test(form);
      setTestResult(res);
    } catch (e: any) {
      setError(e.message || '測試連線失敗');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (isEdit && existing) {
        await accountsApi.update(existing.id, form);
      } else {
        await accountsApi.create(form);
      }
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onDone();
    } catch (e: any) {
      setError(e.message || '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>帳號名稱 (label)</label>
          <input className={inputCls} value={form.label} onChange={(e) => set('label', e.target.value)} placeholder="例如: 公司信箱" />
        </div>
        <div>
          <label className={labelCls}>Email 地址</label>
          <input className={inputCls} value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="user@example.com" required />
        </div>
      </div>

      <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2">IMAP 伺服器</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Host</label>
            <input className={inputCls} value={form.imapHost} onChange={(e) => set('imapHost', e.target.value)} required />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input type="number" className={inputCls} value={form.imapPort} onChange={(e) => set('imapPort', parseInt(e.target.value) || 993)} />
          </div>
        </div>
        <label className="flex items-center gap-2 mt-2 text-xs">
          <input type="checkbox" checked={form.imapUseTls} onChange={(e) => set('imapUseTls', e.target.checked)} className="w-4 h-4 rounded" />
          使用 TLS (implicit)
        </label>
        <label className="flex items-center gap-2 mt-1.5 text-xs">
          <input type="checkbox" checked={!!form.imapAllowInsecureTls} onChange={(e) => set('imapAllowInsecureTls', e.target.checked)} className="w-4 h-4 rounded" />
          允許自簽憑證 (Allow insecure TLS)
        </label>
      </div>

      <div className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
        <div className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-2">SMTP 伺服器</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Host</label>
            <input className={inputCls} value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} required />
          </div>
          <div>
            <label className={labelCls}>Port</label>
            <input type="number" className={inputCls} value={form.smtpPort} onChange={(e) => set('smtpPort', parseInt(e.target.value) || 587)} />
          </div>
        </div>
        <label className="flex items-center gap-2 mt-2 text-xs">
          <input type="checkbox" checked={form.smtpUseTls} onChange={(e) => set('smtpUseTls', e.target.checked)} className="w-4 h-4 rounded" />
          使用 TLS
        </label>
        <label className="flex items-center gap-2 mt-1.5 text-xs">
          <input type="checkbox" checked={!!form.smtpAllowInsecureTls} onChange={(e) => set('smtpAllowInsecureTls', e.target.checked)} className="w-4 h-4 rounded" />
          允許自簽憑證
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>使用者名稱</label>
          <input className={inputCls} value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="通常=email" />
        </div>
        <div>
          <label className={labelCls}>密碼 {isEdit ? '(留空=不變)' : ''}</label>
          <input type="password" className={inputCls} value={form.password} onChange={(e) => set('password', e.target.value)} placeholder="••••••••" required={!isEdit} />
        </div>
      </div>

      {testResult && (
        <div className="flex items-center gap-3 text-xs px-2">
          <span className={`flex items-center gap-1 ${testResult.imap === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {testResult.imap === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />} IMAP
          </span>
          <span className={`flex items-center gap-1 ${testResult.smtp === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            {testResult.smtp === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />} SMTP
          </span>
        </div>
      )}

      {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">{error}</div>}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button type="button" onClick={handleTest} disabled={testing} className="px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 disabled:opacity-50 flex items-center gap-1.5">
          {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 測試連線
        </button>
        <button type="submit" disabled={saving} className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50 flex items-center gap-1.5">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 儲存
        </button>
      </div>
    </form>
  );
};

export const AccountsPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { setView } = useMailStore();
  const activeAccount = useActiveAccount();
  const [editing, setEditing] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: accounts, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.list,
    staleTime: 30000,
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => accountsApi.setDefault(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => accountsApi.remove(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });

  const handleDelete = async (acc: Account) => {
    if (!window.confirm(`確定要刪除帳號「${acc.label || acc.email}」嗎？此操作無法復原。`)) return;
    setDeletingId(acc.id);
    try {
      await deleteMutation.mutateAsync(acc.id);
    } finally {
      setDeletingId(null);
    }
  };

  const showForm = creating || editing;

  return (
    <main className="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 h-full overflow-hidden">
      <div className="flex items-center gap-3 px-4 md:px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={() => setView('mail')} className="p-2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Settings2 className="w-4 h-4 text-blue-600" />
          帳號管理
        </h1>
      </div>

      {showForm ? (
        <div className="flex-1 overflow-y-auto p-4 md:p-6 max-w-2xl w-full mx-auto">
          <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 mb-4">
            {creating ? '新增帳號' : `編輯帳號 — ${editing?.label || editing?.email}`}
          </h2>
          <AccountsForm
            existing={editing || null}
            onDone={() => {
              setCreating(false);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <button
            onClick={() => setCreating(true)}
            className="mb-4 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center gap-1.5 transition"
          >
            <Plus className="w-4 h-4" /> 新增帳號
          </button>

          {isLoading ? (
            <div className="p-8 text-center text-xs text-slate-400">正在載入帳號...</div>
          ) : (accounts?.length ?? 0) === 0 ? (
            <div className="p-12 text-center text-slate-400 text-xs">未有帳號，請新增第一個帳號。</div>
          ) : (
            <div className="space-y-2 max-w-2xl">
              {accounts?.map((acc) => (
                <div key={acc.id} className="flex items-center gap-3 p-3.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
                  <div className="w-9 h-9 rounded-full bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 flex items-center justify-center shrink-0">
                    <UserRound className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                      {acc.label || acc.email}
                      {acc.isDefault && (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400 rounded">預設</span>
                      )}
                      {activeAccount?.id === acc.id && (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 rounded">使用中</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {acc.email} · {acc.imapHost}:{acc.imapPort}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setDefaultMutation.mutate(acc.id)}
                      disabled={acc.isDefault}
                      className="p-2 text-slate-500 hover:text-amber-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg disabled:opacity-30 transition"
                      title="設為預設帳號"
                    >
                      <Star className={`w-4 h-4 ${acc.isDefault ? 'fill-amber-400 text-amber-400' : ''}`} />
                    </button>
                    <button
                      onClick={() => {
                        setEditing(acc);
                        setCreating(false);
                      }}
                      className="p-2 text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                      title="編輯"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(acc)}
                      disabled={deletingId === acc.id || accounts?.length === 1}
                      className="p-2 text-slate-500 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg disabled:opacity-30 transition"
                      title={accounts?.length === 1 ? '不能刪除最後一個帳號' : '刪除'}
                    >
                      {deletingId === acc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
};

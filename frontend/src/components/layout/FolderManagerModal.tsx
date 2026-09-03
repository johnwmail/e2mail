import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X,
  Inbox,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Archive,
  Folder,
  Loader2,
  RefreshCw,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { accountsApi } from '../../api/accounts';
import { toast } from '../../stores/useToastStore';
import { Account, FolderInfo } from '../../types/api';
import { folderDisplayName, useI18n } from '../../i18n';

const getFolderIcon = (specialUse?: string, name?: string) => {
  const key = (specialUse || name || '').toLowerCase();
  if (key.includes('inbox')) return <Inbox className="w-4 h-4" />;
  if (key.includes('sent')) return <Send className="w-4 h-4" />;
  if (key.includes('draft')) return <FileText className="w-4 h-4" />;
  if (key.includes('trash') || key.includes('bin')) return <Trash2 className="w-4 h-4" />;
  if (key.includes('junk') || key.includes('spam')) return <AlertOctagon className="w-4 h-4" />;
  if (key.includes('archive')) return <Archive className="w-4 h-4" />;
  return <Folder className="w-4 h-4" />;
};

const FolderManagerModal: React.FC<{
  account: Account;
  onClose: () => void;
}> = ({ account, onClose }) => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<Record<string, boolean>>({});

  const { data: folders, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['folders', account.id],
    queryFn: () => mailApi.getFolders(account.id),
    staleTime: 30000,
  });

  // e2Mail-only folder 顯示偏好（唔影響 IMAP subscription）
  const { data: prefs, refetch: refetchPrefs } = useQuery({
    queryKey: ['folderPrefs', account.id],
    queryFn: () => accountsApi.getFolderPrefs(account.id),
    staleTime: 30000,
  });

  const isVisible = (folder: FolderInfo): boolean =>
    prefs?.[folder.name] ?? true;

  const toggle = async (folder: FolderInfo) => {
    const next = !isVisible(folder);
    // 寫入 e2Mail 專屬偏好（唔 send IMAP subscribe/unsubscribe）
    setPending((p) => ({ ...p, [folder.name]: true }));
    try {
      await accountsApi.setFolderPref(account.id, folder.name, next);
      await refetchPrefs();
    } finally {
      setPending((p) => ({ ...p, [folder.name]: false }));
    }
  };

  // ===== 頂層 folder 顯示次序（↑/↓ 重排）=====
  const delim = folders?.[0]?.delimiter || '/';
  const isTopLevel = (name: string) => !name.includes(delim);
  const topFolders = (folders ?? []).filter((f) => isTopLevel(f.name) && isVisible(f));

  const { data: savedOrder, refetch: refetchOrder } = useQuery({
    queryKey: ['folderOrder', account.id],
    queryFn: () => accountsApi.getFolderOrder(account.id),
    staleTime: 30000,
  });

  // 依 saved order 排好頂層 folders；其餘補尾
  const orderedTopFolders = (() => {
    const ordered = (savedOrder ?? [])
      .map((name) => topFolders.find((f) => f.name === name))
      .filter(Boolean) as FolderInfo[];
    const missing = topFolders.filter((f) => !(savedOrder ?? []).includes(f.name));
    return [...ordered, ...missing];
  })();

  const persistOrder = async (order: string[]) => {
    try {
      await accountsApi.setFolderOrder(account.id, order);
      await refetchOrder();
    } catch (e: any) {
      toast(t('folderManager.saveOrderFailed', { error: e?.message || e }));
    }
  };

  const moveTop = async (index: number, dir: -1 | 1) => {
    const next = [...orderedTopFolders];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    await persistOrder(next.map((f) => f.name));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
            {t('folderManager.accountTitle', { account: account.label || account.email })}
          </h2>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-400">
          <span>{t('folderManager.hint')}</span>
          <button onClick={() => refetch()} className={`flex items-center gap-1 hover:text-slate-600 transition ${isFetching ? 'animate-spin' : ''}`}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* 頂層資料夾顯示次序（↑/↓ 重排） */}
        {orderedTopFolders.length > 0 && (
          <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800">
            <div className="text-[11px] font-semibold text-slate-500 mb-1.5">{t('folderManager.topLevelOrder')}</div>
            <div className="space-y-1">
              {orderedTopFolders.map((f, i) => (
                <div key={f.name} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-2 py-1.5">
                  <span className="text-slate-400">{getFolderIcon(f.specialUse, f.name)}</span>
                  <span className="flex-1 min-w-0 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                    {folderDisplayName(f.name, f.specialUse)}
                  </span>
                  <button onClick={() => moveTop(i, -1)} disabled={i === 0} className="p-1 text-slate-400 hover:text-blue-600 rounded disabled:opacity-20 transition" title={t('folderManager.moveUp')}>
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => moveTop(i, 1)} disabled={i === orderedTopFolders.length - 1} className="p-1 text-slate-400 hover:text-blue-600 rounded disabled:opacity-20 transition" title={t('folderManager.moveDown')}>
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {isLoading ? (
            <div className="p-8 text-center text-slate-400 text-xs">{t('folderManager.loading')}</div>
          ) : (
            folders?.map((folder) => {
              const disabled = folder.specialUse === 'inbox' || folder.name.toUpperCase() === 'INBOX';
              const isPending = pending[folder.name];
              return (
                <label key={folder.name} className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition">
                  <input
                    type="checkbox"
                    checked={disabled || isVisible(folder)}
                    disabled={disabled || isPending}
                    onChange={() => toggle(folder)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-0"
                  />
                  <span className="text-slate-400">{getFolderIcon(folder.specialUse, folder.name)}</span>
                  <span className="flex-1 min-w-0 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                    {folderDisplayName(folder.name, folder.specialUse)}
                  </span>
                  {disabled && <span className="text-[10px] text-slate-400 shrink-0">{t('folderManager.required')}</span>}
                  {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
                </label>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default FolderManagerModal;

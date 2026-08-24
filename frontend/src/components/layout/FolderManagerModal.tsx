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
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { accountsApi } from '../../api/accounts';
import { Account, FolderInfo } from '../../types/api';

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

const getFolderDisplayName = (folder: FolderInfo) => {
  switch (folder.specialUse) {
    case 'inbox':
      return '收件箱';
    case 'sent':
      return '已發送';
    case 'drafts':
      return '草稿箱';
    case 'trash':
      return '垃圾桶';
    case 'junk':
      return '垃圾郵件';
    case 'archive':
      return '封存';
    default:
      return folder.name;
  }
};

const FolderManagerModal: React.FC<{
  account: Account;
  onClose: () => void;
}> = ({ account, onClose }) => {
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<Record<string, boolean>>({});

  const { data: folders, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['folders', account.id],
    queryFn: () => mailApi.getFolders(account.id),
    staleTime: 30000,
  });

  // WebMail-only folder 顯示偏好（唔影響 IMAP subscription）
  const { data: prefs, refetch: refetchPrefs } = useQuery({
    queryKey: ['folderPrefs', account.id],
    queryFn: () => accountsApi.getFolderPrefs(account.id),
    staleTime: 30000,
  });

  const isVisible = (folder: FolderInfo): boolean =>
    prefs?.[folder.name] ?? true;

  const toggle = async (folder: FolderInfo) => {
    const next = !isVisible(folder);
    // 寫入 WebMail 專屬偏好（唔 send IMAP subscribe/unsubscribe）
    setPending((p) => ({ ...p, [folder.name]: true }));
    try {
      await accountsApi.setFolderPref(account.id, folder.name, next);
      await refetchPrefs();
    } finally {
      setPending((p) => ({ ...p, [folder.name]: false }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-bold text-slate-900 dark:text-white truncate">
            資料夾管理 — {account.label || account.email}
          </h2>
          <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-400">
          <span>勾選嘅資料夾會顯示喺側邊欄</span>
          <button onClick={() => refetch()} className={`flex items-center gap-1 hover:text-slate-600 transition ${isFetching ? 'animate-spin' : ''}`}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {isLoading ? (
            <div className="p-8 text-center text-slate-400 text-xs">正在載入資料夾...</div>
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
                    {getFolderDisplayName(folder)}
                  </span>
                  {disabled && <span className="text-[10px] text-slate-400 shrink-0">必選</span>}
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

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Inbox,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Archive,
  Folder,
  PenSquare,
  RefreshCw,
  X,
  Key,
  ShieldCheck,
  LogOut,
  ChevronDown,
  ChevronRight,
  UserRound,
  Settings2,
  ListTree,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { pgpService } from '../../api/pgp';
import { useMailStore } from '../../stores/useMailStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { FolderInfo, Account } from '../../types/api';
import { PgpKeyModal } from '../mail/PgpKeyModal';
import FolderManagerModal from './FolderManagerModal';
import { buildInfo } from '../../buildInfo';

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

// 只有已訂閱（或 INBOX）嘅 folder 先顯示喺側邊欄
const isVisibleFolder = (f: FolderInfo) => f.subscribed || f.specialUse === 'inbox' || f.name.toUpperCase() === 'INBOX';

const AccountFolders: React.FC<{
  account: Account;
  expanded: boolean;
  onToggleExpand: () => void;
  setSidebarOpen: (open: boolean) => void;
}> = ({ account, expanded, onToggleExpand, setSidebarOpen }) => {
  const { currentFolder, setCurrentFolder, setActiveAccountId } = useMailStore();
  const isActiveAccount = useActiveAccount()?.id === account.id;
  const [isManagerOpen, setIsManagerOpen] = useState(false);

  const { data: folders, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['folders', account.id],
    queryFn: () => mailApi.getFolders(account.id),
    enabled: expanded,
    staleTime: 30000,
  });

  const visibleFolders = folders?.filter(isVisibleFolder) ?? [];
  const accountUnread = visibleFolders.reduce((sum, f) => sum + f.unreadCount, 0) ?? 0;

  return (
    <div>
      <button
        onClick={onToggleExpand}
        className={`w-full flex items-center gap-2 px-2.5 py-2.5 rounded-xl text-xs font-semibold transition ${
          isActiveAccount
            ? 'text-blue-700 dark:text-blue-400'
            : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        <span className="text-slate-400">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <span className="flex items-center gap-2 truncate">
          <span className="w-5 h-5 rounded bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <UserRound className="w-3.5 h-3.5" />
          </span>
          <span className="truncate">{account.label || account.email}</span>
        </span>
        {accountUnread > 0 && (
          <span className="ml-auto px-2 py-0.5 text-[10px] font-bold bg-blue-600 text-white rounded-full shrink-0">
            {accountUnread}
          </span>
        )}
      </button>

      {expanded && (
        <>
          <nav className="space-y-1 ml-5 border-l border-slate-200 dark:border-slate-800 pl-2 mb-2">
            {isLoading ? (
              <div className="p-3 text-xs text-slate-400">正在載入資料夾...</div>
            ) : visibleFolders.length === 0 ? (
              <div className="p-3 text-xs text-slate-400">未有已訂閱資料夾</div>
            ) : (
              visibleFolders.map((folder) => {
                const isActive = isActiveAccount && currentFolder === folder.name;
                return (
                  <div
                    key={folder.name}
                    className={`flex items-center rounded-lg transition ${
                      isActive
                        ? 'bg-blue-50 dark:bg-blue-950/60'
                        : 'hover:bg-slate-200/60 dark:hover:bg-slate-800'
                    }`}
                  >
                    <button
                      onClick={() => {
                        setActiveAccountId(account.id);
                        setCurrentFolder(folder.name);
                        setSidebarOpen(false);
                      }}
                      className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition ${
                        isActive ? 'text-blue-700 dark:text-blue-400 font-semibold' : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 truncate">
                        <span className={isActive ? 'text-blue-600' : 'text-slate-400'}>
                          {getFolderIcon(folder.specialUse, folder.name)}
                        </span>
                        <span className="truncate">{getFolderDisplayName(folder)}</span>
                      </div>
                      {folder.unreadCount > 0 && (
                        <span className="px-2 py-0.5 text-[10px] font-bold bg-blue-600 text-white rounded-full shrink-0">
                          {folder.unreadCount}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })
            )}
            <button
              onClick={() => refetch()}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-slate-600 transition ${isFetching ? 'animate-spin' : ''}`}
              title="重新整理資料夾"
            >
              <RefreshCw className="w-3 h-3" /> 重新整理
            </button>
            <button
              onClick={() => setIsManagerOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-blue-600 hover:text-blue-700 transition"
            >
              <ListTree className="w-3 h-3" /> 資料夾管理
            </button>
          </nav>
          {isManagerOpen && (
            <FolderManagerModal account={account} onClose={() => setIsManagerOpen(false)} />
          )}
        </>
      )}
    </div>
  );
};

export const Sidebar: React.FC = () => {
  const { openComposer, isSidebarOpen, setSidebarOpen, setView } = useMailStore();
  const { session, logout } = useAuthStore();
  const [isPgpModalOpen, setIsPgpModalOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    session?.accounts?.forEach((a, i) => {
      init[a.id] = i === 0;
    });
    return init;
  });

  const hasPgpKey = !!pgpService.getKeyPair();
  const accounts = session?.accounts ?? [];

  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));

  const sidebarContent = (
    <div className="flex flex-col h-full justify-between p-3.5 select-none overflow-y-auto">
      <div className="space-y-4">
        {/* 行動端抽屜頂部帳號條 */}
        <div className="lg:hidden flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-xs shrink-0 shadow-sm">
              {session?.email?.[0]?.toUpperCase() || 'U'}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-bold text-slate-900 dark:text-white truncate">
                {session?.email}
              </div>
              <div className="text-[10px] text-slate-400">{accounts.length} 個帳號</div>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 rounded-lg shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 寫信按鈕 */}
        <button
          onClick={() => {
            openComposer();
            setSidebarOpen(false);
          }}
          className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold flex items-center justify-center gap-2 shadow-sm transition"
        >
          <PenSquare className="w-4 h-4" />
          撰寫新郵件
        </button>

        {/* 帳號資料夾樹 */}
        <div>
          <div className="flex items-center justify-between px-2 mb-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">信箱</span>
            <button
              onClick={() => setView('accounts')}
              className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 transition"
              title="管理帳號"
            >
              <Settings2 className="w-3.5 h-3.5" /> 管理帳號
            </button>
          </div>

          <div className="space-y-1">
            {accounts.map((account, idx) => (
              <AccountFolders
                key={account.id}
                account={account}
                expanded={collapsed[account.id] ?? idx === 0}
                onToggleExpand={() => toggleCollapsed(account.id)}
                setSidebarOpen={setSidebarOpen}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 側邊欄底部：PGP 設定與登出按鈕 */}
      <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-slate-800 mt-4">
        <button
          onClick={() => {
            setIsPgpModalOpen(true);
            setSidebarOpen(false);
          }}
          className="w-full flex items-center justify-between p-2.5 bg-indigo-50/80 hover:bg-indigo-100 dark:bg-indigo-950/40 dark:hover:bg-indigo-900/60 text-indigo-900 dark:text-indigo-200 rounded-xl text-xs font-semibold transition border border-indigo-200/60 dark:border-indigo-800/50"
        >
          <div className="flex items-center gap-2">
            <Key className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <span>PGP 金鑰設定</span>
          </div>
          {hasPgpKey ? (
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
          ) : (
            <span className="text-[10px] text-amber-600 font-medium">未配置</span>
          )}
        </button>

        {/* 行動端登出按鈕 */}
        <button
          onClick={logout}
          className="lg:hidden w-full flex items-center gap-2 p-2.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl text-xs font-semibold transition"
        >
          <LogOut className="w-4 h-4" />
          <span>登出帳號</span>
        </button>
      </div>

      {/* Build 資訊 */}
      <div className="pt-2 text-[10px] font-mono text-slate-400 dark:text-slate-500 leading-relaxed select-none">
        <p>{buildInfo.version} · {buildInfo.commitHash}</p>
        <p>built {buildInfo.buildTime}</p>
      </div>

      <PgpKeyModal isOpen={isPgpModalOpen} onClose={() => setIsPgpModalOpen(false)} />
    </div>
  );

  return (
    <>
      {/* 桌面端靜態側邊欄 (≥ lg) */}
      <aside className="hidden lg:flex w-60 bg-slate-50/80 dark:bg-slate-900/50 border-r border-slate-200 dark:border-slate-800 flex-col shrink-0 select-none">
        {sidebarContent}
      </aside>

      {/* 行動端抽屜式側邊欄 (< lg) */}
      {isSidebarOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm transition-opacity"
          />
          <div className="relative w-72 max-w-[80vw] bg-white dark:bg-slate-900 h-full shadow-2xl z-10 animate-in slide-in-from-left duration-200">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};

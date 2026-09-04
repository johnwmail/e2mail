import React, { useEffect, useState } from 'react';
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
  LogOut,
  ChevronDown,
  ChevronRight,
  UserRound,
  Settings2,
  ListTree,
  Plus,
  Minus,
  Loader2,
  MailOpen,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { accountsApi } from '../../api/accounts';
import { toast } from '../../stores/useToastStore';
import { useMailStore } from '../../stores/useMailStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { FolderInfo, Account } from '../../types/api';
import FolderManagerModal from './FolderManagerModal';
import ConfirmDialog from '../ui/ConfirmDialog';
import { buildInfo } from '../../buildInfo';
import { folderDisplayName, t, useI18n } from '../../i18n';

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

const getFolderDisplayName = (folder: FolderInfo) =>
  folderDisplayName(folder.name, folder.specialUse);

// 只有 INBOX 或「e2Mail 偏好設為顯示」嘅 folder 先顯示喺側邊欄（唔依賴 IMAP subscription）
const isVisibleFolder = (f: FolderInfo, prefs: Record<string, boolean> | undefined) =>
  f.specialUse === 'inbox' || f.name.toUpperCase() === 'INBOX' || (prefs?.[f.name] ?? true);

// 計數用：是否垃圾桶 / Virtual（排除於頂層合計）
const isTrashFolder = (f: FolderInfo) => f.specialUse === 'trash' || /trash|bin|垃圾/i.test(f.name);
const isVirtualFolder = (f: FolderInfo) => /^virtual(\/|$)/i.test(f.name);
const isTopLevelFolder = (f: FolderInfo) => {
  const delim = f.delimiter || '/';
  return !f.name.includes(delim);
};

// 樹狀節點：將 flat folder list 依 delimiter + name path 組成樹
interface FolderNode {
  path: string;        // 完整資料夾名（name）
  displayName: string; // 最後一段睇到嘅名
  folder?: FolderInfo; // 若 node 對應一個實際 folder（leaf or 有 own unread）
  children: Map<string, FolderNode>;
}

function buildFolderTree(folders: FolderInfo[]): FolderNode {
  const root: FolderNode = { path: '', displayName: '', children: new Map() };
  // 確保祖先 nodes 都存在（即使未有對應 folder）
  for (const f of folders) {
    const delim = f.delimiter || '/';
    const parts = f.name.split(delim).filter(Boolean);
    let node = root;
    let path = '';
    parts.forEach((part, idx) => {
      path = idx === 0 ? part : path + delim + part;
      if (!node.children.has(part)) {
        node.children.set(part, { path, displayName: part, children: new Map() });
      }
      node = node.children.get(part)!;
      if (idx === parts.length - 1) {
        node.folder = f;
      }
    });
  }
  return root;
}

// 遞迴 folder tree 節點（支援 +/- 展開/收合）
const FolderBranch: React.FC<{
  node: FolderNode;
  depth: number;
  accountId: string;
  isActiveAccount: boolean;
  currentFolder: string;
  onSelectFolder: (name: string) => void;
  setSidebarOpen: (open: boolean) => void;
  expandedMap: Record<string, boolean>;
  onToggle: (path: string) => void;
}> = ({ node, depth, accountId, isActiveAccount, currentFolder, onSelectFolder, setSidebarOpen, expandedMap, onToggle }) => {
  const { t } = useI18n();
  const hasChildren = node.children.size > 0;
  const isExpanded = expandedMap[node.path] ?? false;
  const isActive = isActiveAccount && currentFolder === node.path;
  // Virtual folder（Dovecot 儲存搜尋）只係其他地方郵件嘅鏡像，唔顯示 unread badge
  const isVirtualNode = /^virtual(\/|$)/i.test(node.path);
  const unread = isVirtualNode ? 0 : (node.folder?.unreadCount ?? 0);
  const isTrash = node.folder?.specialUse === 'trash' || /trash|bin|垃圾/i.test(node.path);
  const [emptying, setEmptying] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const queryClient = useQueryClient();

  const handleEmptyTrash = async () => {
    setConfirmEmpty(false);
    setEmptying(true);
    try {
      await mailApi.emptyFolder(node.path, accountId);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, node.path] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    } catch (e: any) {
      toast(t('sidebar.emptyFailed', { error: e?.message || e }));
    } finally {
      setEmptying(false);
    }
  };

  return (
    <div>
      <div className={`flex items-center rounded-lg transition ${isActive ? 'bg-blue-50 dark:bg-blue-950/60' : 'hover:bg-slate-200/60 dark:hover:bg-slate-800'}`}>
        {hasChildren ? (
          <button
            onClick={() => onToggle(node.path)}
            className="flex items-center justify-center w-5 h-5 shrink-0 text-slate-400 hover:text-slate-600"
            title={isExpanded ? t('sidebar.collapse') : t('sidebar.expand')}
          >
            {isExpanded ? <Minus className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => {
            onSelectFolder(node.path);
            setSidebarOpen(false);
          }}
          className={`flex-1 min-w-0 flex items-center justify-between pl-1 pr-2.5 py-2 rounded-lg text-xs font-medium transition ${
            isActive ? 'text-blue-700 dark:text-blue-400 font-semibold' : 'text-slate-700 dark:text-slate-300'
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <div className="flex items-center gap-2.5 truncate">
            <span className={isActive ? 'text-blue-600' : 'text-slate-400'}>
              {node.folder ? getFolderIcon(node.folder.specialUse, node.folder.name) : <Folder className="w-4 h-4" />}
            </span>
            <span className="truncate">{node.displayName}</span>
          </div>
          {unread > 0 && (
            <span className="px-2 py-0.5 text-[10px] font-bold bg-blue-600 text-white rounded-full shrink-0">
              {unread}
            </span>
          )}
        </button>
        {isTrash && (
          <button
            onClick={() => setConfirmEmpty(true)}
            disabled={emptying}
            className="flex items-center justify-center w-6 h-6 mr-1 shrink-0 text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 transition disabled:opacity-40"
            title={t('sidebar.emptyTrash')}
            aria-label={t('sidebar.emptyTrashTitle')}
          >
            {emptying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {hasChildren && isExpanded && (
        <div className="border-l border-slate-200 dark:border-slate-800 ml-[11px]">
          {Array.from(node.children.values()).map((child) => (
            <FolderBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              accountId={accountId}
              isActiveAccount={isActiveAccount}
              currentFolder={currentFolder}
              onSelectFolder={onSelectFolder}
              setSidebarOpen={setSidebarOpen}
              expandedMap={expandedMap}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={confirmEmpty}
        title={t('sidebar.emptyTrashTitle')}
        message={t('sidebar.emptyTrashConfirm', { name: node.displayName })}
        confirmText={t('sidebar.empty')}
        danger
        loading={emptying}
        onConfirm={handleEmptyTrash}
        onCancel={() => setConfirmEmpty(false)}
      />
    </div>
  );
};

const AccountFolders: React.FC<{
  account: Account;
  expanded: boolean;
  onToggleExpand: () => void;
  setSidebarOpen: (open: boolean) => void;
}> = ({ account, expanded, onToggleExpand, setSidebarOpen }) => {
  const { t } = useI18n();
  const { currentFolder, setCurrentFolder, setActiveAccountId, setInboxUnread, unreadView, setUnreadView } = useMailStore();
  const isActiveAccount = useActiveAccount()?.id === account.id;
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(() => {
    // 預設展開有 children 嘅 folder？改為預設全收合；用戶可 +/- 展開
    return {};
  });

  const toggleFolder = (path: string) =>
    setExpandedFolders((prev) => ({ ...prev, [path]: !prev[path] }));

  const { data: folders, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['folders', account.id],
    queryFn: () => mailApi.getFolders(account.id),
    enabled: isActiveAccount || expanded,
    staleTime: 30000,
  });

  // 同步 inbox 未讀數至全 app store（mobile header Menu badge 用）
  useEffect(() => {
    if (!isActiveAccount) return;
    const inbox = folders?.find((f) => f.specialUse === 'inbox' || /^inbox$/i.test(f.name));
    setInboxUnread(inbox?.unreadCount ?? 0);
  }, [folders, isActiveAccount, setInboxUnread]);

  // e2Mail-only folder 顯示偏好（唔影響 IMAP subscription）
  const { data: folderPrefs } = useQuery({
    queryKey: ['folderPrefs', account.id],
    queryFn: () => accountsApi.getFolderPrefs(account.id),
    enabled: expanded,
    staleTime: 30000,
  });

  // 頂層 folder 顯示次序
  const { data: folderOrder } = useQuery({
    queryKey: ['folderOrder', account.id],
    queryFn: () => accountsApi.getFolderOrder(account.id),
    enabled: expanded,
    staleTime: 30000,
  });

  const visibleFolders = folders?.filter((f) => isVisibleFolder(f, folderPrefs)) ?? [];
  // 頂層合計：只計頂層 folder，不包括垃圾桶及 Virtual
  const accountUnread =
    visibleFolders
      .filter((f) => isTopLevelFolder(f) && !isTrashFolder(f) && !isVirtualFolder(f))
      .reduce((sum, f) => sum + f.unreadCount, 0) ?? 0;

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
            {/* 未讀 Smart 列表（純 App 前端合併，唔係真 imap folder） */}
            <button
              onClick={() => {
                setActiveAccountId(account.id);
                setUnreadView(true);
                setSidebarOpen(false);
              }}
              className={`w-full flex items-center justify-between py-2 pl-[28px] pr-2.5 rounded-lg text-xs font-medium transition ${
                isActiveAccount && unreadView
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800'
              }`}
              title={t('sidebar.allUnread')}
            >
              <span className="flex items-center gap-2.5 truncate">
                <MailOpen className="w-4 h-4 text-slate-400" />
                <span className="truncate">{t('header.unread')}</span>
              </span>
              {accountUnread > 0 && (
                <span className="px-2 py-0.5 text-[10px] font-bold bg-blue-600 text-white rounded-full shrink-0">
                  {accountUnread}
                </span>
              )}
            </button>

            {isLoading ? (
              <div className="p-3 text-xs text-slate-400">{t('sidebar.loadingFolders')}</div>
            ) : visibleFolders.length === 0 ? (
              <div className="p-3 text-xs text-slate-400">{t('sidebar.noFolders')}</div>
            ) : (
              (() => {
                const tree = buildFolderTree(visibleFolders);
                const children = Array.from(tree.children.values());
                // 依 folderOrder（頂層次序）排序；無次序記錄則保存原本
                const order = folderOrder ?? [];
                if (order.length > 0) {
                  children.sort((a, b) => {
                    const ia = order.indexOf(a.path);
                    const ib = order.indexOf(b.path);
                    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
                  });
                }
                return children.map((child) => (
                  <FolderBranch
                    key={child.path}
                    node={child}
                    depth={0}
                    accountId={account.id}
                    isActiveAccount={isActiveAccount}
                    currentFolder={currentFolder}
                    onSelectFolder={(name) => {
                      setActiveAccountId(account.id);
                      setCurrentFolder(name);
                    }}
                    setSidebarOpen={setSidebarOpen}
                    expandedMap={expandedFolders}
                    onToggle={toggleFolder}
                  />
                ));
              })()
            )}
            <button
              onClick={() => refetch()}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-slate-600 transition ${isFetching ? 'animate-spin' : ''}`}
              title={t('sidebar.refreshFolders')}
            >
              <RefreshCw className="w-3 h-3" /> {t('common.refresh')}
            </button>
            <button
              onClick={() => setIsManagerOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] text-blue-600 hover:text-blue-700 transition"
            >
              <ListTree className="w-3 h-3" /> {t('sidebar.folderManager')}
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
  const { t } = useI18n();
  const { openComposer, isSidebarOpen, setSidebarOpen, openSettings } = useMailStore();
  const { session, logout } = useAuthStore();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    session?.accounts?.forEach((a, i) => {
      init[a.id] = i === 0;
    });
    return init;
  });

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
              <div className="text-[10px] text-slate-400">{t('sidebar.accountsCount', { count: accounts.length })}</div>
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
          {t('sidebar.writeMail')}
        </button>

        {/* 帳號資料夾樹 */}
        <div>
          <div className="flex items-center px-2 mb-1">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{t('sidebar.mailboxes')}</span>
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

      {/* 側邊欄底部：設定與登出按鈕 */}
      <div className="space-y-2 pt-3 border-t border-slate-200 dark:border-slate-800 mt-4">
        <button
          onClick={() => {
            openSettings();
          }}
          className="w-full min-h-10 flex items-center gap-2 p-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-xl text-xs font-semibold transition border border-slate-200 dark:border-slate-700"
        >
          <Settings2 className="w-4 h-4 text-slate-600 dark:text-slate-400" />
          <span>{t('sidebar.settings')}</span>
        </button>

        {/* 行動端登出按鈕 */}
        <button
          onClick={logout}
          className="lg:hidden w-full flex items-center gap-2 p-2.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-xl text-xs font-semibold transition"
        >
          <LogOut className="w-4 h-4" />
          <span>{t('sidebar.logout')}</span>
        </button>
      </div>

      {/* Build 資訊 */}
      <div className="pt-2 text-[10px] font-mono text-slate-400 dark:text-slate-500 leading-relaxed select-none">
        <p>Version: {buildInfo.version}</p>
        <p>CommitHash: {buildInfo.commitHash.slice(0, 7)}</p>
        <p>BuildTime: {buildInfo.buildTime}</p>
      </div>
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

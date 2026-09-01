import React, { useEffect, useState } from 'react';
import { Mail, Search, LogOut, PenSquare, X, Menu, Key, MessagesSquare } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { useAuthStore } from '../../stores/useAuthStore';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { mailApi } from '../../api/mail';
import { PgpKeyModal } from '../mail/PgpKeyModal';
import { FolderInfo } from '../../types/api';

export const Header: React.FC = () => {
  const { session, logout } = useAuthStore();
  const { searchQuery, searchInput, setSearchQuery, setSearchInput, clearSearch, openComposer, toggleSidebar, selectedUID, currentFolder, setActiveAccountId, unreadView, setUnreadView, listMode, setListMode } = useMailStore();
  const activeAccount = useActiveAccount();
  const [isMobileSearchOpen, setIsMobileSearchOpen] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isPgpModalOpen, setIsPgpModalOpen] = useState(false);

  // 點擊未讀 badge → 切去該帳號嘅動態未讀虛擬列表（純 App 前端合併）
  const openUnread = () => {
    const acc = activeAccount || session?.accounts?.[0];
    if (!acc) return;
    setActiveAccountId(acc.id);
    setUnreadView(true);
  };

  // Debounce：停低輸入 800ms 之後先 commit 落 searchQuery 觸發後台全文搜尋。
  // 每次打字都 reset，所以快速／連住打都只會 send 一次。Enter 仍可即時提交。
  useEffect(() => {
    const q = searchInput.trim();
    if (q === searchQuery) return;
    const t = setTimeout(() => setSearchQuery(q), 800);
    return () => clearTimeout(t);
  }, [searchInput, searchQuery, setSearchQuery]);

  // Gmail 風格搜尋運算符（點擊加入輸入欄）
  const searchOperators = [
    'from:',
    'to:',
    'subject:',
    'body:',
    'is:unread',
    'is:read',
    'is:starred',
    'has:attachment',
    'after:2024-01-01',
    'before:2024-12-31',
  ];
  const showSearchHint = isSearchFocused && (searchInput.trim() !== '' || searchInput.includes(':'));
  const appendSearchOperator = (op: string) => {
    setSearchInput((searchInput.trim() ? searchInput.trim() + ' ' : '') + op);
  };

  // 頂層合計：所有帳號嘅頂層 folder 未讀總和，不包括垃圾桶及 Virtual
  const accounts = session?.accounts ?? [];
  const foldersQueries = useQueries({
    queries: accounts.map((acc) => ({
      queryKey: ['folders', acc.id] as const,
      queryFn: () => mailApi.getFolders(acc.id),
      staleTime: 30000,
    })),
  });

  const totalUnread = foldersQueries.reduce((sum: number, q) => {
    if (!Array.isArray(q.data)) return sum;
    for (const f of q.data as FolderInfo[]) {
      const isTrash = f.specialUse === 'trash' || /trash|bin|垃圾/i.test(f.name);
      const isVirtual = /^virtual(\/|$)/i.test(f.name);
      const delim = f.delimiter || '/';
      const isTopLevel = !f.name.includes(delim);
      if (!isTopLevel || isTrash || isVirtual) continue;
      sum += f.unreadCount ?? 0;
    }
    return sum;
  }, 0);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
    setIsMobileSearchOpen(false);
  };

  const handleClearSearch = () => {
    clearSearch();
  };

  const getFolderDisplayName = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('inbox')) return '收件箱';
    if (n.includes('sent')) return '已發送';
    if (n.includes('draft')) return '草稿箱';
    if (n.includes('trash') || n.includes('bin')) return '垃圾桶';
    if (n.includes('junk') || n.includes('spam')) return '垃圾郵件';
    if (n.includes('archive')) return '封存';
    return name;
  };

  return (
    <>
      <header
        className={`h-14 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 md:px-4 flex items-center justify-between shrink-0 select-none z-30 relative safe-top ${
          selectedUID !== null ? 'hidden lg:flex' : 'flex'
        }`}
      >
        {/* 行動端全螢幕搜尋列 */}
        {isMobileSearchOpen ? (
          <div className="absolute inset-0 bg-white dark:bg-slate-900 px-3 flex items-center gap-2 z-40 safe-top">
            <form onSubmit={handleSearchSubmit} className="flex-1 relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
              <input
                type="text"
                autoFocus
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜尋郵件主旨、內文或寄件者...（可用 from: is:unread）"
                className="w-full pl-9 pr-8 py-1.5 text-sm bg-slate-100 dark:bg-slate-800 border-0 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </form>
            <button
              onClick={() => setIsMobileSearchOpen(false)}
              className="p-2 text-xs font-semibold text-slate-600 dark:text-slate-300"
            >
              取消
            </button>
          </div>
        ) : (
          <>
            {/* 左側：漢堡選單 (Mobile) / Logo (Desktop) */}
            <div className="flex items-center gap-2.5">
              <div className="lg:hidden relative">
                <button
                  onClick={toggleSidebar}
                  className="p-2 -ml-1 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                  title="開啟選單"
                >
                  <Menu className="w-5 h-5" />
                </button>
                {totalUnread > 0 && (
                  <button
                    onClick={openUnread}
                    className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-600 text-white text-[9px] font-bold leading-none border-2 border-white dark:border-slate-900 hover:bg-red-700 transition"
                    title="查看所有未讀郵件"
                  >
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white shadow-sm shrink-0">
                  <Mail className="w-4 h-4" />
                </div>
                <div className="flex flex-col">
                  <span className="font-bold text-sm md:text-base text-slate-900 dark:text-white leading-tight">
                    e2Mail
                  </span>
                  <span className="lg:hidden text-[11px] text-slate-400 font-medium leading-none mt-0.5">
                    {unreadView ? '未讀' : getFolderDisplayName(currentFolder)}
                  </span>
                </div>
              </div>
            </div>

            {/* 中間搜尋欄 (Desktop 顯示) */}
            <div className="hidden md:flex flex-1 max-w-xl px-4 relative">
              <form onSubmit={handleSearchSubmit} className="relative w-full">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onFocus={() => setIsSearchFocused(true)}
                  onBlur={() => setIsSearchFocused(false)}
                  placeholder="搜尋郵件主旨、內文或寄件者...（可用 from: to: is:unread）"
                  className="w-full pl-9 pr-8 py-1.5 text-sm bg-slate-100 dark:bg-slate-800 border-0 rounded-lg outline-none focus:ring-2 focus:ring-blue-500 placeholder-slate-400"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </form>

              {showSearchHint && (
                <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg p-2.5 text-left">
                  <p className="text-[11px] text-slate-400 mb-1.5 px-1">進階搜尋運算符（點擊插入）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {searchOperators.map((op) => (
                      <button
                        key={op}
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => appendSearchOperator(op)}
                        className="px-2 py-1 text-[11px] font-mono rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 hover:text-blue-600 transition"
                      >
                        {op}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 右側操作按鈕 */}
            <div className="flex items-center gap-1.5 md:gap-2.5">
              {/* 行動端搜尋觸發按鈕 */}
              <button
                onClick={() => setIsMobileSearchOpen(true)}
                className="md:hidden p-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                title="搜尋"
              >
                <Search className="w-4 h-4" />
              </button>

              {/* Threads 模式 on/off（未讀虛擬列表唔支援對話串） */}
              {!unreadView && (
                <button
                  onClick={() => setListMode(listMode === 'threads' ? 'messages' : 'threads')}
                  className={`p-2 rounded-lg transition ${listMode === 'threads' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                  title={listMode === 'threads' ? '切換為單封模式' : '切換為對話串模式'}
                  aria-label={listMode === 'threads' ? '切換為單封模式' : '切換為對話串模式'}
                >
                  <MessagesSquare className="w-4 h-4" />
                </button>
              )}

              {/* PGP 金鑰管理按鈕 */}
              <button
                onClick={() => setIsPgpModalOpen(true)}
                className="flex items-center gap-1 p-2 md:px-2.5 md:py-1.5 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold transition"
                title="PGP / GPG 端到端加密金鑰管理"
              >
                <Key className="w-4 h-4 md:w-3.5 md:h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span className="hidden md:inline">PGP 金鑰</span>
              </button>

              {/* 寫信按鈕 */}
              <button
                onClick={() => openComposer()}
                className="flex items-center gap-1 px-2.5 py-1.5 md:px-3 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition shadow-sm"
              >
                <PenSquare className="w-4 h-4 md:w-3.5 md:h-3.5" />
                <span className="hidden sm:inline">寫信</span>
              </button>

              <div className="hidden md:block h-4 w-px bg-slate-200 dark:bg-slate-700 mx-0.5" />

              {/* 使用者頭像 (Desktop 顯示) */}
              <div className="hidden md:flex items-center gap-1.5">
                <div className="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs">
                  {session?.email?.[0]?.toUpperCase() || 'U'}
                </div>
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300 max-w-[120px] truncate hidden xl:inline">
                  {session?.email}
                </span>
              </div>

              {/* 登出按鈕 (Desktop 顯示) */}
              <button
                onClick={logout}
                className="hidden md:block p-1.5 text-slate-500 hover:text-red-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition"
                title="登出"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </header>

      {/* PGP 金鑰管理 Modal */}
      <PgpKeyModal isOpen={isPgpModalOpen} onClose={() => setIsPgpModalOpen(false)} />
    </>
  );
};

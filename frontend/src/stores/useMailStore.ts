import { create } from 'zustand';
import { OutgoingMessage } from '../types/api';

interface MailState {
  currentFolder: string;
  activeAccountId: string | null;
  selectedUID: number | null;
  searchQuery: string;
  searchInput: string;
  unreadView: boolean;
  page: number;
  limit: number;
  isComposerOpen: boolean;
  composerDraft: Partial<OutgoingMessage> | null;
  composerKey: number;
  isSidebarOpen: boolean;
  view: 'mail' | 'accounts' | 'contacts';
  inboxUnread: number;
  listMode: 'messages' | 'threads';

  setCurrentFolder: (folder: string) => void;
  setActiveAccountId: (id: string | null) => void;
  setSelectedUID: (uid: number | null) => void;
  setSearchQuery: (q: string) => void;
  setSearchInput: (input: string) => void;
  clearSearch: () => void;
  setUnreadView: (flag: boolean) => void;
  setPage: (page: number) => void;
  openComposer: (draft?: Partial<OutgoingMessage>) => void;
  closeComposer: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setView: (view: 'mail' | 'accounts' | 'contacts') => void;
  setInboxUnread: (n: number) => void;
  setListMode: (mode: 'messages' | 'threads') => void;
}

export const useMailStore = create<MailState>((set) => ({
  currentFolder: 'INBOX',
  activeAccountId: null,
  selectedUID: null,
  searchQuery: '',
  searchInput: '',
  unreadView: false,
  page: 1,
  limit: 50,
  isComposerOpen: false,
  composerDraft: null,
  composerKey: 0,
  isSidebarOpen: false,
  view: 'mail',
  inboxUnread: 0,
  listMode: (localStorage.getItem('webmail_list_mode') === 'threads' ? 'threads' : 'messages'),

  setCurrentFolder: (folder) =>
    set({ currentFolder: folder, selectedUID: null, page: 1, isSidebarOpen: false, unreadView: false }),

  setActiveAccountId: (id) =>
    set({ activeAccountId: id, currentFolder: 'INBOX', selectedUID: null, page: 1, inboxUnread: 0, unreadView: false }),

  setSelectedUID: (uid) => set({ selectedUID: uid }),

  setSearchQuery: (q) => set({ searchQuery: q, page: 1, selectedUID: null }),

  setSearchInput: (input) => set({ searchInput: input }),

  clearSearch: () =>
    set({ searchInput: '', searchQuery: '', page: 1, selectedUID: null }),

  setUnreadView: (flag) => set({ unreadView: flag, page: 1, selectedUID: null }),

  setPage: (page) => set({ page }),

  openComposer: (draft = {}) =>
    set((s) => ({ isComposerOpen: true, composerDraft: draft, composerKey: s.composerKey + 1 })),

  closeComposer: () =>
    set({ isComposerOpen: false, composerDraft: null }),

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  setView: (view) => set({ view }),

  setInboxUnread: (n) => set({ inboxUnread: n }),

  setListMode: (mode) => {
    localStorage.setItem('webmail_list_mode', mode);
    set({ listMode: mode, page: 1, selectedUID: null });
    // 同步到 DB（後台，失敗唔阻塞 UI）
    void import('../api/prefs').then(({ prefsApi }) =>
      prefsApi.set('listMode', mode).catch(() => {})
    );
  },
}));

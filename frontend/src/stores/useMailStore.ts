import { create } from 'zustand';
import { OutgoingMessage } from '../types/api';

export type SettingsSection = 'security' | 'pgp' | 'accounts' | 'sieve' | 'contacts' | 'appearance';
export type ThemePreference = 'light' | 'dark' | 'system';

interface MailState {
  currentFolder: string;
  activeAccountId: string | null;
  selectedUID: number | null;
  selectedFolder: string | null;
  searchQuery: string;
  searchInput: string;
  unreadView: boolean;
  page: number;
  limit: number;
  isComposerOpen: boolean;
  composerDraft: Partial<OutgoingMessage> | null;
  composerKey: number;
  isSidebarOpen: boolean;
  view: 'mail' | 'settings';
  settingsSection: SettingsSection;
  inboxUnread: number;
  listMode: 'messages' | 'threads';
  theme: ThemePreference;

  setCurrentFolder: (folder: string) => void;
  setActiveAccountId: (id: string | null) => void;
  setSelectedUID: (uid: number | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setSearchQuery: (q: string) => void;
  setSearchInput: (input: string) => void;
  clearSearch: () => void;
  setUnreadView: (flag: boolean) => void;
  setPage: (page: number) => void;
  openComposer: (draft?: Partial<OutgoingMessage>) => void;
  closeComposer: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setView: (view: 'mail' | 'settings') => void;
  openSettings: (section?: SettingsSection) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setInboxUnread: (n: number) => void;
  setListMode: (mode: 'messages' | 'threads') => void;
  setTheme: (theme: ThemePreference) => void;
}

export const useMailStore = create<MailState>((set) => ({
  currentFolder: 'INBOX',
  activeAccountId: null,
  selectedUID: null,
  selectedFolder: null,
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
  settingsSection: 'security',
  inboxUnread: 0,
  listMode: (localStorage.getItem('webmail_list_mode') === 'threads' ? 'threads' : 'messages'),
  theme: (() => {
    const stored = localStorage.getItem('webmail_theme');
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  })(),

  setCurrentFolder: (folder) =>
    set({ currentFolder: folder, selectedUID: null, selectedFolder: null, page: 1, isSidebarOpen: false, unreadView: false }),

  setActiveAccountId: (id) =>
    set({ activeAccountId: id, currentFolder: 'INBOX', selectedUID: null, selectedFolder: null, page: 1, inboxUnread: 0, unreadView: false }),

  setSelectedUID: (uid) =>
    set((s) => ({ selectedUID: uid, selectedFolder: uid === null ? null : s.selectedFolder })),

  setSelectedFolder: (folder) => set({ selectedFolder: folder }),

  setSearchQuery: (q) => set({ searchQuery: q, page: 1, selectedUID: null, selectedFolder: null }),

  setSearchInput: (input) => set({ searchInput: input }),

  clearSearch: () =>
    set({ searchInput: '', searchQuery: '', page: 1, selectedUID: null, selectedFolder: null }),

  setUnreadView: (flag) => set({ unreadView: flag, page: 1, selectedUID: null, selectedFolder: null }),

  setPage: (page) => set({ page }),

  openComposer: (draft = {}) =>
    set((s) => ({ isComposerOpen: true, composerDraft: draft, composerKey: s.composerKey + 1 })),

  closeComposer: () =>
    set({ isComposerOpen: false, composerDraft: null }),

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  setView: (view) => set({ view, isSidebarOpen: false }),

  openSettings: (settingsSection = 'security') =>
    set({ view: 'settings', settingsSection, isSidebarOpen: false }),

  setSettingsSection: (settingsSection) => set({ settingsSection }),

  setInboxUnread: (n) => set({ inboxUnread: n }),

  setListMode: (mode) => {
    localStorage.setItem('webmail_list_mode', mode);
    set({ listMode: mode, page: 1, selectedUID: null, selectedFolder: null });
    // 同步到 DB（後台，失敗唔阻塞 UI）；加 catch 處理 import 於測試環境 teardown 時之錯誤
    void import('../api/prefs')
      .then(({ prefsApi }) => prefsApi.set('listMode', mode).catch(() => {}))
      .catch(() => {});
  },

  setTheme: (theme) => {
    localStorage.setItem('webmail_theme', theme);
    set({ theme });
    void import('../api/prefs')
      .then(({ prefsApi }) => prefsApi.set('theme', theme).catch(() => {}))
      .catch(() => {});
  },
}));

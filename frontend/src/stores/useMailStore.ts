import { create } from 'zustand';
import { OutgoingMessage } from '../types/api';

interface MailState {
  currentFolder: string;
  activeAccountId: string | null;
  selectedUID: number | null;
  searchQuery: string;
  page: number;
  limit: number;
  isComposerOpen: boolean;
  composerDraft: Partial<OutgoingMessage> | null;
  isSidebarOpen: boolean;
  view: 'mail' | 'accounts';

  setCurrentFolder: (folder: string) => void;
  setActiveAccountId: (id: string | null) => void;
  setSelectedUID: (uid: number | null) => void;
  setSearchQuery: (q: string) => void;
  setPage: (page: number) => void;
  openComposer: (draft?: Partial<OutgoingMessage>) => void;
  closeComposer: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setView: (view: 'mail' | 'accounts') => void;
}

export const useMailStore = create<MailState>((set) => ({
  currentFolder: 'INBOX',
  activeAccountId: null,
  selectedUID: null,
  searchQuery: '',
  page: 1,
  limit: 50,
  isComposerOpen: false,
  composerDraft: null,
  isSidebarOpen: false,
  view: 'mail',

  setCurrentFolder: (folder) =>
    set({ currentFolder: folder, selectedUID: null, page: 1, isSidebarOpen: false }),

  setActiveAccountId: (id) =>
    set({ activeAccountId: id, currentFolder: 'INBOX', selectedUID: null, page: 1 }),

  setSelectedUID: (uid) => set({ selectedUID: uid }),

  setSearchQuery: (q) => set({ searchQuery: q, page: 1, selectedUID: null }),

  setPage: (page) => set({ page }),

  openComposer: (draft = {}) =>
    set({ isComposerOpen: true, composerDraft: draft }),

  closeComposer: () =>
    set({ isComposerOpen: false, composerDraft: null }),

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),

  setView: (view) => set({ view }),
}));

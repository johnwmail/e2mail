import { create } from 'zustand';
import { OutgoingMessage } from '../types/api';

interface MailState {
  currentFolder: string;
  selectedUID: number | null;
  searchQuery: string;
  page: number;
  limit: number;
  isComposerOpen: boolean;
  composerDraft: Partial<OutgoingMessage> | null;
  isSidebarOpen: boolean;

  setCurrentFolder: (folder: string) => void;
  setSelectedUID: (uid: number | null) => void;
  setSearchQuery: (q: string) => void;
  setPage: (page: number) => void;
  openComposer: (draft?: Partial<OutgoingMessage>) => void;
  closeComposer: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useMailStore = create<MailState>((set) => ({
  currentFolder: 'INBOX',
  selectedUID: null,
  searchQuery: '',
  page: 1,
  limit: 50,
  isComposerOpen: false,
  composerDraft: null,
  isSidebarOpen: false,

  setCurrentFolder: (folder) =>
    set({ currentFolder: folder, selectedUID: null, page: 1, isSidebarOpen: false }),

  setSelectedUID: (uid) => set({ selectedUID: uid }),

  setSearchQuery: (q) => set({ searchQuery: q, page: 1, selectedUID: null }),

  setPage: (page) => set({ page }),

  openComposer: (draft = {}) =>
    set({ isComposerOpen: true, composerDraft: draft }),

  closeComposer: () =>
    set({ isComposerOpen: false, composerDraft: null }),

  setSidebarOpen: (open) => set({ isSidebarOpen: open }),

  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
}));

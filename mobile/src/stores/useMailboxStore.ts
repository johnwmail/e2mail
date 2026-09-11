import { create } from 'zustand';
import type { Account, FolderInfo } from '@e2mail/shared';

interface MailboxState {
  activeAccountId: string | null;
  currentFolder: string;
  unreadView: boolean;
  folderDrawerOpen: boolean;
  setActiveAccountId: (id: string | null) => void;
  setCurrentFolder: (folder: string) => void;
  setUnreadView: (flag: boolean) => void;
  setFolderDrawerOpen: (open: boolean) => void;
  ensureAccount: (accounts: Account[]) => void;
}

export const useMailboxStore = create<MailboxState>((set, get) => ({
  activeAccountId: null,
  currentFolder: 'INBOX',
  unreadView: false,
  folderDrawerOpen: false,

  setActiveAccountId: (id) =>
    set({
      activeAccountId: id,
      currentFolder: 'INBOX',
      unreadView: false,
      folderDrawerOpen: false,
    }),

  setCurrentFolder: (folder) =>
    set({ currentFolder: folder, unreadView: false, folderDrawerOpen: false }),

  setUnreadView: (flag) => set({ unreadView: flag, folderDrawerOpen: false }),

  setFolderDrawerOpen: (open) => set({ folderDrawerOpen: open }),

  ensureAccount: (accounts) => {
    if (!accounts.length) {
      set({ activeAccountId: null });
      return;
    }
    const current = get().activeAccountId;
    if (current && accounts.some((a) => a.id === current)) return;
    const def = accounts.find((a) => a.isDefault) ?? accounts[0];
    set({ activeAccountId: def.id, currentFolder: 'INBOX' });
  },
}));

export function isVisibleFolder(
  f: FolderInfo,
  prefs: Record<string, boolean> | undefined
): boolean {
  return f.specialUse === 'inbox' || f.name.toUpperCase() === 'INBOX' || (prefs?.[f.name] ?? true);
}

export function sortFolders(folders: FolderInfo[], order: string[]): FolderInfo[] {
  if (!order.length) return folders;
  const rank = new Map(order.map((name, i) => [name, i]));
  return [...folders].sort((a, b) => {
    const ia = rank.has(a.name) ? rank.get(a.name)! : 1000;
    const ib = rank.has(b.name) ? rank.get(b.name)! : 1000;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
}

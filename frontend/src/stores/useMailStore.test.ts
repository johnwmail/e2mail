import { describe, it, expect, beforeEach } from 'vitest';
import { useMailStore } from './useMailStore';

describe('useMailStore', () => {
  beforeEach(() => {
    useMailStore.setState({
      currentFolder: 'INBOX',
      selectedUID: null,
      searchQuery: '',
      page: 1,
      isComposerOpen: false,
      composerDraft: null,
      isSidebarOpen: false,
      view: 'mail',
      settingsSection: 'security',
    });
  });

  it('has sensible defaults', () => {
    const s = useMailStore.getState();
    expect(s.currentFolder).toBe('INBOX');
    expect(s.selectedUID).toBeNull();
    expect(s.searchQuery).toBe('');
    expect(s.page).toBe(1);
    expect(s.limit).toBe(50);
    expect(s.isComposerOpen).toBe(false);
    expect(s.isSidebarOpen).toBe(false);
  });

  it('setCurrentFolder resets selection, page and sidebar', () => {
    useMailStore.getState().setSelectedUID(42);
    useMailStore.getState().setPage(3);
    useMailStore.getState().setSidebarOpen(true);

    useMailStore.getState().setCurrentFolder('Sent');

    const s = useMailStore.getState();
    expect(s.currentFolder).toBe('Sent');
    expect(s.selectedUID).toBeNull();
    expect(s.page).toBe(1);
    expect(s.isSidebarOpen).toBe(false);
  });

  it('setSelectedUID updates selection', () => {
    useMailStore.getState().setSelectedUID(7);
    expect(useMailStore.getState().selectedUID).toBe(7);
  });

  it('setSearchQuery resets page and selection', () => {
    useMailStore.getState().setSelectedUID(5);
    useMailStore.getState().setPage(4);

    useMailStore.getState().setSearchQuery('hello');

    const s = useMailStore.getState();
    expect(s.searchQuery).toBe('hello');
    expect(s.page).toBe(1);
    expect(s.selectedUID).toBeNull();
  });

  it('openComposer stores draft, closeComposer clears it', () => {
    useMailStore.getState().openComposer({ subject: 'Hi' });

    let s = useMailStore.getState();
    expect(s.isComposerOpen).toBe(true);
    expect(s.composerDraft).toEqual({ subject: 'Hi' });

    useMailStore.getState().closeComposer();

    s = useMailStore.getState();
    expect(s.isComposerOpen).toBe(false);
    expect(s.composerDraft).toBeNull();
  });

  it('openComposer defaults to empty draft', () => {
    useMailStore.getState().openComposer();
    expect(useMailStore.getState().composerDraft).toEqual({});
  });

  it('toggleSidebar flips state', () => {
    expect(useMailStore.getState().isSidebarOpen).toBe(false);
    useMailStore.getState().toggleSidebar();
    expect(useMailStore.getState().isSidebarOpen).toBe(true);
    useMailStore.getState().toggleSidebar();
    expect(useMailStore.getState().isSidebarOpen).toBe(false);
  });

  it('opens a requested settings section and closes the sidebar', () => {
    useMailStore.getState().setSidebarOpen(true);
    useMailStore.getState().openSettings('sieve');

    const s = useMailStore.getState();
    expect(s.view).toBe('settings');
    expect(s.settingsSection).toBe('sieve');
    expect(s.isSidebarOpen).toBe(false);
  });

  it('persists the selected theme', () => {
    useMailStore.getState().setTheme('dark');
    expect(useMailStore.getState().theme).toBe('dark');
    expect(localStorage.getItem('webmail_theme')).toBe('dark');
  });

  it('setListMode toggles instantly, resets page/selection and persists', () => {
    useMailStore.getState().setPage(3);
    useMailStore.getState().setSelectedUID(42);

    useMailStore.getState().setListMode('threads');
    let s = useMailStore.getState();
    expect(s.listMode).toBe('threads');
    expect(s.page).toBe(1);
    expect(s.selectedUID).toBeNull();
    expect(localStorage.getItem('webmail_list_mode')).toBe('threads');

    useMailStore.getState().setListMode('messages');
    s = useMailStore.getState();
    expect(s.listMode).toBe('messages');
    expect(localStorage.getItem('webmail_list_mode')).toBe('messages');
  });
});
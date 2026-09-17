import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import { useAuthStore } from '../../stores/useAuthStore';
import { useMailStore } from '../../stores/useMailStore';
import { Account, Session } from '../../types/api';

vi.mock('../../api/pgp', () => ({
  pgpService: { clearKey: vi.fn(), fetchKeyringFromCloud: vi.fn(), getKey: vi.fn() },
}));

vi.mock('../../api/mail', () => ({
  mailApi: { getFolders: vi.fn().mockResolvedValue([]), emptyFolder: vi.fn() },
}));

vi.mock('../../api/accounts', () => ({
  accountsApi: {
    getFolderPrefs: vi.fn().mockResolvedValue({}),
    getFolderOrder: vi.fn().mockResolvedValue([]),
  },
}));

function mkAccount(id: string, email: string): Account {
  return {
    id,
    label: email,
    email,
    imapHost: 'mail.example.com',
    imapPort: 993,
    imapUseTls: true,
    imapAllowInsecureTls: false,
    smtpHost: 'mail.example.com',
    smtpPort: 587,
    smtpUseTls: true,
    smtpAllowInsecureTls: false,
    sieveHost: '',
    sievePort: 0,
    sieveUseTls: true,
    sieveAllowInsecureTls: false,
    username: email,
    isDefault: true,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as Account;
}

function renderSidebar(hideDesktop: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Sidebar hideDesktop={hideDesktop} />
    </QueryClientProvider>
  );
}

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const account = mkAccount('acc-1', 'me@example.com');
    useAuthStore.setState({
      session: {
        id: 's1',
        email: 'me@example.com',
        username: '',
        accounts: [account],
        createdAt: '',
        lastActiveAt: '',
      } as Session,
    });
    useMailStore.setState({ isSidebarOpen: false, activeAccountId: 'acc-1', view: 'mail' });
  });

  it('does not render the mobile drawer until opened', () => {
    renderSidebar(false);
    expect(screen.queryByTestId('mobile-sidebar')).not.toBeInTheDocument();
  });

  it('renders the mobile drawer when opened', () => {
    useMailStore.setState({ isSidebarOpen: true });
    renderSidebar(false);
    expect(screen.getByTestId('mobile-sidebar')).toBeInTheDocument();
  });

  it('hides only the desktop aside (drawer still mounts) on the settings page', () => {
    renderSidebar(true);
    const desktop = screen.getByTestId('desktop-sidebar');
    expect(desktop.className).not.toContain('lg:flex');

    useMailStore.setState({ isSidebarOpen: true });
    renderSidebar(true);
    expect(screen.getAllByTestId('mobile-sidebar').length).toBeGreaterThan(0);
  });
});

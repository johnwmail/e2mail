import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SecurityTab } from './SecurityTab';
import { useAuthStore } from '../../stores/useAuthStore';
import { Account, Session } from '../../types/api';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  changePassword: vi.fn(),
  waList: vi.fn(),
  waRegisterBegin: vi.fn(),
  waRegisterFinish: vi.fn(),
  waRename: vi.fn(),
  waRemove: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock('../../api/2fa', () => ({
  twoFApi: { getStatus: mocks.getStatus },
  webauthnApi: {
    list: mocks.waList,
    registerBegin: mocks.waRegisterBegin,
    registerFinish: mocks.waRegisterFinish,
    rename: mocks.waRename,
    remove: mocks.waRemove,
  },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: mocks.startRegistration,
}));

vi.mock('../../api/auth', () => ({
  authApi: { changePassword: mocks.changePassword },
}));

vi.mock('../../api/pgp', () => ({
  pgpService: { clearKey: vi.fn() },
}));

function stubServerConfig(ldapEnabled: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { ldapEnabled } }),
    })
  );
}

function mkAccount(over: Partial<Account>): Account {
  return {
    id: 'id',
    label: '',
    email: 'x@example.com',
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
    username: 'x@example.com',
    isDefault: false,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Account;
}

function setSession(accounts: Account[], email: string) {
  useAuthStore.setState({
    session: { id: 's1', email, username: '', accounts, createdAt: '', lastActiveAt: '' } as Session,
  });
}

describe('SecurityTab change-password section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ session: null });
    mocks.getStatus.mockResolvedValue({ enabled: false });
  });

  it('hides the form when LDAP is not enabled', async () => {
    stubServerConfig(false);
    render(<SecurityTab />);
    await screen.findByText('Two-factor authentication is off');
    expect(screen.queryByText('Change login password')).not.toBeInTheDocument();
  });

  it('shows the form and submits via API when enabled', async () => {
    stubServerConfig(true);
    mocks.changePassword.mockResolvedValue({ changed: true });

    render(<SecurityTab />);
    expect(await screen.findByText('Change login password')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('New password (min. 8 characters)'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass456' } });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    await waitFor(() => {
      expect(mocks.changePassword).toHaveBeenCalledWith('OldPass123', 'NewPass456', 'NewPass456', undefined);
    });
    expect(await screen.findByText(/Password updated/)).toBeInTheDocument();
  });

  it('shows account selector with multiple accounts and submits selected account', async () => {
    stubServerConfig(true);
    setSession(
      [
        mkAccount({ id: 'acc-alice', email: 'alice@test.com', isDefault: true }),
        mkAccount({ id: 'acc-bob', email: 'bob@test.com', label: 'Bob 信箱' }),
      ],
      'alice@test.com'
    );
    mocks.changePassword.mockResolvedValue({ changed: true });

    render(<SecurityTab />);
    expect(await screen.findByText('Change login password')).toBeInTheDocument();

    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();
    expect(screen.getByText(/alice@test.com/i)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'acc-bob' } });

    // 切換到非登入主帳號後，標題與說明文字改變
    expect(await screen.findByText('Change account password')).toBeInTheDocument();
    expect(screen.getByText(/Your login password and local encrypted data are unaffected/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'BobOld123' } });
    fireEvent.change(screen.getByLabelText('New password (min. 8 characters)'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass456' } });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    await waitFor(() => {
      expect(mocks.changePassword).toHaveBeenCalledWith('BobOld123', 'NewPass456', 'NewPass456', 'acc-bob');
    });
    expect(await screen.findByText(/Password updated for “Bob 信箱”/)).toBeInTheDocument();
  });

  it('validates confirm mismatch client-side', async () => {
    stubServerConfig(true);
    render(<SecurityTab />);
    await screen.findByText('Change login password');

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('New password (min. 8 characters)'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'Different123' } });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    expect(await screen.findByText('New password and confirmation do not match')).toBeInTheDocument();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('surfaces backend error message', async () => {
    stubServerConfig(true);
    mocks.changePassword.mockRejectedValue(new Error('舊密碼不正確'));

    render(<SecurityTab />);
    await screen.findByText('Change login password');

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'WrongOld123' } });
    fireEvent.change(screen.getByLabelText('New password (min. 8 characters)'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPass456' } });
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));

    expect(await screen.findByText('舊密碼不正確')).toBeInTheDocument();
  });
});

describe('SecurityTab passkeys section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ session: null });
    stubServerConfig(false);
    mocks.getStatus.mockResolvedValue({ enabled: false, webauthnEnabled: true, passkeyCount: 0 });
    mocks.waList.mockResolvedValue({ credentials: [] });
  });

  it('lists existing passkeys and adds a new one', async () => {
    (window as any).PublicKeyCredential = {};
    mocks.getStatus.mockResolvedValue({ enabled: false, webauthnEnabled: true, passkeyCount: 1 });
    mocks.waList.mockResolvedValue({
      credentials: [
        { id: 'c1', name: 'iPhone', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-02T00:00:00Z' },
      ],
    });
    mocks.waRegisterBegin.mockResolvedValue({ challenge: 'cer-1', publicKey: {} });
    mocks.startRegistration.mockResolvedValue({ id: 'newcred' });
    mocks.waRegisterFinish.mockResolvedValue({
      id: 'newcred',
      name: 'Passkey',
      createdAt: '',
      lastUsedAt: '',
    });

    render(<SecurityTab />);
    expect(await screen.findByText('iPhone')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey' }));

    await waitFor(() => {
      expect(mocks.waRegisterBegin).toHaveBeenCalled();
      expect(mocks.startRegistration).toHaveBeenCalled();
      expect(mocks.waRegisterFinish).toHaveBeenCalledWith('cer-1', { id: 'newcred' }, undefined);
    });
    expect(await screen.findByText('Passkey added.')).toBeInTheDocument();

    delete (window as any).PublicKeyCredential;
  });

  it('hides the section when the server disables WebAuthn', async () => {
    (window as any).PublicKeyCredential = {};
    mocks.getStatus.mockResolvedValue({ enabled: false, webauthnEnabled: false });

    render(<SecurityTab />);
    await screen.findByText('Two-factor authentication is off');
    expect(screen.queryByText('Passkeys')).not.toBeInTheDocument();

    delete (window as any).PublicKeyCredential;
  });
});

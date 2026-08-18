import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from './LoginForm';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  verify2fa: vi.fn(),
}));

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: () => ({ login: mocks.login, verify2fa: mocks.verify2fa }),
}));

const loginReq = {
  email: 'a@example.com',
  password: 'secret',
  imapHost: 'example.com',
  imapPort: 993,
  imapUseTls: true,
  imapAllowInsecureTls: false,
  smtpHost: 'example.com',
  smtpPort: 587,
  smtpUseTls: true,
  smtpAllowInsecureTls: false,
};

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // server-config 初始化請求：回傳無預設值
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ success: false }) }));
  });

  it('renders the login form', () => {
    render(<LoginForm />);
    expect(screen.getByRole('heading', { name: '登入 Webmail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登入信箱' })).toBeInTheDocument();
  });

  it('shows error when submitting empty form', async () => {
    const { container } = render(<LoginForm />);
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);
    expect(await screen.findByText('請輸入電子郵件與密碼')).toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('calls login and enters 2FA step when 2FA is required', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: '登入信箱' }));

    await waitFor(() => {
      expect(mocks.login).toHaveBeenCalledWith(loginReq);
    });
    expect(await screen.findByText('兩步驟驗證 (2FA)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '驗證並登入' })).toBeInTheDocument();
  });

  it('submits 2FA code via verify2fa', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });
    mocks.verify2fa.mockResolvedValue(undefined);

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: '登入信箱' }));

    const codeInput = await screen.findByPlaceholderText('••••••');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '驗證並登入' }));

    await waitFor(() => {
      expect(mocks.verify2fa).toHaveBeenCalledWith('ch-1', '123456');
    });
  });

  it('shows error and clears code on failed 2FA verification', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });
    mocks.verify2fa.mockRejectedValue(new Error('驗證碼錯誤，請重試'));

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: '登入信箱' }));

    const codeInput = await screen.findByPlaceholderText('••••••');
    fireEvent.change(codeInput, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '驗證並登入' }));

    expect(await screen.findByText('驗證碼錯誤，請重試')).toBeInTheDocument();
    const cleared = await screen.findByPlaceholderText('••••••');
    expect((cleared as HTMLInputElement).value).toBe('');
  });

  it('back button returns to credentials form', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: '登入信箱' }));

    fireEvent.click(await screen.findByRole('button', { name: '返回重新輸入帳號密碼' }));

    expect(screen.getByRole('button', { name: '登入信箱' })).toBeInTheDocument();
    expect(screen.queryByText('兩步驟驗證 (2FA)')).not.toBeInTheDocument();
  });

  it('shows login error message', async () => {
    mocks.login.mockRejectedValue(new Error('IMAP authentication failed: bad creds'));

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: '登入信箱' }));

    expect(await screen.findByText('IMAP authentication failed: bad creds')).toBeInTheDocument();
  });
});
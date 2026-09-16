import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginForm } from './LoginForm';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  verify2fa: vi.fn(),
  loginWithWebAuthn: vi.fn(),
  loginBegin: vi.fn(),
  startAuthentication: vi.fn(),
}));

vi.mock('../../stores/useAuthStore', () => ({
  useAuthStore: () => ({
    login: mocks.login,
    verify2fa: mocks.verify2fa,
    loginWithWebAuthn: mocks.loginWithWebAuthn,
  }),
}));

vi.mock('../../api/2fa', () => ({
  webauthnApi: { loginBegin: mocks.loginBegin },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: mocks.startAuthentication,
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
    expect(screen.getByRole('heading', { name: 'Sign in to e2Mail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows error when submitting empty form', async () => {
    const { container } = render(<LoginForm />);
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form).toBeTruthy();
    fireEvent.submit(form);
    expect(await screen.findByText('Please enter your email and password')).toBeInTheDocument();
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('calls login and enters 2FA step when 2FA is required', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(mocks.login).toHaveBeenCalledWith(loginReq);
    });
    expect(await screen.findByText('Two-factor authentication (2FA)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeInTheDocument();
  });

  it('submits 2FA code via verify2fa', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });
    mocks.verify2fa.mockResolvedValue(undefined);

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const codeInput = await screen.findByPlaceholderText('••••••');
    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    await waitFor(() => {
      expect(mocks.verify2fa).toHaveBeenCalledWith('ch-1', '123456');
    });
  });

  it('shows error and clears code on failed 2FA verification', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });
    mocks.verify2fa.mockRejectedValue(new Error('Invalid code. Try again.'));

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const codeInput = await screen.findByPlaceholderText('••••••');
    fireEvent.change(codeInput, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));

    expect(await screen.findByText('Invalid code. Try again.')).toBeInTheDocument();
    const cleared = await screen.findByPlaceholderText('••••••');
    expect((cleared as HTMLInputElement).value).toBe('');
  });

  it('back button returns to credentials form', async () => {
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1' });

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Back to email and password' }));

    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByText('Two-factor authentication (2FA)')).not.toBeInTheDocument();
  });

  it('shows login error message', async () => {
    mocks.login.mockRejectedValue(new Error('IMAP authentication failed: bad creds'));

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('IMAP authentication failed: bad creds')).toBeInTheDocument();
  });

  it('offers passkey login and completes via WebAuthn when method is available', async () => {
    (window as any).PublicKeyCredential = {};
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1', methods: ['webauthn'] });
    mocks.loginBegin.mockResolvedValue({ challenge: 'cer-1', publicKey: { challenge: 'x' } });
    mocks.startAuthentication.mockResolvedValue({ id: 'cred-1' });
    mocks.loginWithWebAuthn.mockResolvedValue(undefined);

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    const passkeyBtn = await screen.findByRole('button', { name: /Use Face ID/ });
    fireEvent.click(passkeyBtn);

    await waitFor(() => {
      expect(mocks.loginBegin).toHaveBeenCalledWith('ch-1');
      expect(mocks.startAuthentication).toHaveBeenCalled();
      expect(mocks.loginWithWebAuthn).toHaveBeenCalledWith('cer-1', { id: 'cred-1' });
    });

    delete (window as any).PublicKeyCredential;
  });

  it('does not offer passkey login when the method is unavailable', async () => {
    (window as any).PublicKeyCredential = {};
    mocks.login.mockResolvedValue({ requires2fa: true, challenge: 'ch-1', methods: ['totp'] });

    render(<LoginForm />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: loginReq.email } });
    fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: loginReq.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText('Two-factor authentication (2FA)');
    expect(screen.queryByRole('button', { name: /Use Face ID/ })).not.toBeInTheDocument();

    delete (window as any).PublicKeyCredential;
  });
});
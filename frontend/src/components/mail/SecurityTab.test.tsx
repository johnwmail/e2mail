import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SecurityTab } from './SecurityTab';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  changePassword: vi.fn(),
}));

vi.mock('../../api/2fa', () => ({
  twoFApi: { getStatus: mocks.getStatus },
}));

vi.mock('../../api/auth', () => ({
  authApi: { changePassword: mocks.changePassword },
}));

function stubServerConfig(ldapEnabled: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      json: async () => ({ success: true, data: { ldapEnabled } }),
    })
  );
}

describe('SecurityTab change-password section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getStatus.mockResolvedValue({ enabled: false });
  });

  it('hides the form when LDAP is not enabled', async () => {
    stubServerConfig(false);
    render(<SecurityTab />);
    await screen.findByText('兩步驟驗證未啟用');
    expect(screen.queryByText('變更登入密碼')).not.toBeInTheDocument();
  });

  it('shows the form and submits via API when enabled', async () => {
    stubServerConfig(true);
    mocks.changePassword.mockResolvedValue({ changed: true });

    render(<SecurityTab />);
    expect(await screen.findByText('變更登入密碼')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('舊密碼'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('新密碼（至少 8 字）'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('確認新密碼'), { target: { value: 'NewPass456' } });
    fireEvent.click(screen.getByRole('button', { name: /變更密碼/ }));

    await waitFor(() => {
      expect(mocks.changePassword).toHaveBeenCalledWith('OldPass123', 'NewPass456', 'NewPass456');
    });
    expect(await screen.findByText(/密碼已變更/)).toBeInTheDocument();
  });

  it('validates confirm mismatch client-side', async () => {
    stubServerConfig(true);
    render(<SecurityTab />);
    await screen.findByText('變更登入密碼');

    fireEvent.change(screen.getByLabelText('舊密碼'), { target: { value: 'OldPass123' } });
    fireEvent.change(screen.getByLabelText('新密碼（至少 8 字）'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('確認新密碼'), { target: { value: 'Different123' } });
    fireEvent.click(screen.getByRole('button', { name: /變更密碼/ }));

    expect(await screen.findByText('新密碼與確認密碼不一致')).toBeInTheDocument();
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('surfaces backend error message', async () => {
    stubServerConfig(true);
    mocks.changePassword.mockRejectedValue(new Error('舊密碼不正確'));

    render(<SecurityTab />);
    await screen.findByText('變更登入密碼');

    fireEvent.change(screen.getByLabelText('舊密碼'), { target: { value: 'WrongOld123' } });
    fireEvent.change(screen.getByLabelText('新密碼（至少 8 字）'), { target: { value: 'NewPass456' } });
    fireEvent.change(screen.getByLabelText('確認新密碼'), { target: { value: 'NewPass456' } });
    fireEvent.click(screen.getByRole('button', { name: /變更密碼/ }));

    expect(await screen.findByText('舊密碼不正確')).toBeInTheDocument();
  });
});

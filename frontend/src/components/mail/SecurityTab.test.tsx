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
      expect(mocks.changePassword).toHaveBeenCalledWith('OldPass123', 'NewPass456', 'NewPass456');
    });
    expect(await screen.findByText(/Password updated/)).toBeInTheDocument();
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

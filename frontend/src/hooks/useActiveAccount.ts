import { useEffect } from 'react';
import { useAuthStore } from '../stores/useAuthStore';
import { useMailStore } from '../stores/useMailStore';
import { Account } from '../types/api';

export function useActiveAccount(): Account | null {
  const session = useAuthStore((s) => s.session);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);

  const accounts = session?.accounts ?? [];

  // 初始化/回退到 default 帳號
  useEffect(() => {
    if (accounts.length === 0) return;
    const stillExists = accounts.some((a) => a.id === activeAccountId);
    if (!stillExists) {
      const def = accounts.find((a) => a.isDefault) ?? accounts[0];
      setActiveAccountId(def.id);
    }
  }, [accounts, activeAccountId, setActiveAccountId]);

  if (!activeAccountId) return null;
  return accounts.find((a) => a.id === activeAccountId) ?? null;
}

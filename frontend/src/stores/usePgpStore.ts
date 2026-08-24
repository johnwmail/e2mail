import { create } from 'zustand';
import { pgpService, PgpKeyPair } from '../api/pgp';

interface PgpState {
  // 版本號：每次 key 改變 +1，令依賴嘅 component re-render
  version: number;
  hasKey: boolean;
  refresh: () => void;
}

export const usePgpStore = create<PgpState>((set) => ({
  version: 0,
  hasKey: !!pgpService.getKeyPair(),
  refresh: () =>
    set((state) => ({
      version: state.version + 1,
      hasKey: !!pgpService.getKeyPair(),
    })),
}));

// 方便喺任何地方 refresh（例如 fetch cloud 完成後）
export function refreshPgp() {
  usePgpStore.getState().refresh();
}

export type { PgpKeyPair };

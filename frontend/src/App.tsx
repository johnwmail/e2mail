import React, { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from './stores/useAuthStore';
import { useMailStore } from './stores/useMailStore';
import { useActiveAccount } from './hooks/useActiveAccount';
import { LoginForm } from './components/auth/LoginForm';
import { Header } from './components/layout/Header';
import { Sidebar } from './components/layout/Sidebar';
import { MessageList } from './components/layout/MessageList';
import { ViewerPane } from './components/layout/ViewerPane';
import { Composer } from './components/mail/Composer';
import { AccountsPage } from './components/accounts/AccountsPage';
import { connectEvents } from './api/sse';
import { pgpService } from './api/pgp';

export const App: React.FC = () => {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading, initAuth, token, logout } = useAuthStore();
  const view = useMailStore((s) => s.view);
  const activeAccount = useActiveAccount();

  useEffect(() => {
    initAuth();

    const handleUnauthorized = () => {
      logout();
    };
    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [initAuth, logout]);

  // 登入後自動檢查並自雲端同步 PGP 加密金鑰包（跨裝置無縫加載）
  useEffect(() => {
    if (isAuthenticated) {
      const localKey = pgpService.getKeyPair();
      if (!localKey) {
        pgpService.fetchKeyringFromCloud().then((cloudKey) => {
          if (cloudKey) {
            console.log('✅ 已成功自雲端同步 PGP 密文金鑰包:', cloudKey.keyId);
          }
        });
      }
    }
  }, [isAuthenticated]);

  // 訂閱 SSE 即時新信通知
  useEffect(() => {
    if (!token || !isAuthenticated) return;

    const disconnect = connectEvents(token, (event) => {
      console.log('[SSE Event]', event);
      if (event.type === 'NEW_MESSAGE' || event.type === 'FLAG_UPDATE' || event.type === 'EXPUNGE') {
        if (event.accountId) {
          queryClient.invalidateQueries({ queryKey: ['messages', event.accountId] });
          queryClient.invalidateQueries({ queryKey: ['folders', event.accountId] });
        } else {
          queryClient.invalidateQueries({ queryKey: ['messages'] });
          queryClient.invalidateQueries({ queryKey: ['folders'] });
        }
      }
    });

    return () => {
      disconnect();
    };
  }, [token, isAuthenticated, queryClient]);

  if (isLoading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-900 text-white text-sm">
        正在載入 Modern Webmail...
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginForm />;
  }

  return (
    <div className="h-[100dvh] w-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
      <Header />
      <div className="flex-1 flex overflow-hidden relative">
        {view === 'accounts' ? (
          <AccountsPage />
        ) : (
          <>
            <Sidebar />
            <MessageList />
            <ViewerPane />
          </>
        )}
      </div>
      {view === 'mail' && activeAccount && <Composer />}
    </div>
  );
};

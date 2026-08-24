import React, { useEffect, useState } from 'react';
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
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { connectEvents } from './api/sse';
import { pgpService } from './api/pgp';
import { refreshPgp } from './stores/usePgpStore';
import { onboardingApi } from './api/onboarding';

export const App: React.FC = () => {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading, initAuth, token, logout } = useAuthStore();
  const view = useMailStore((s) => s.view);
  const activeAccount = useActiveAccount();
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    initAuth();

    const handleUnauthorized = () => {
      logout();
    };
    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [initAuth, logout]);

  // 登入後檢查 onboarding 完成度（2FA + PGP）；未完成則顯示 wizard
  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try {
        const st = await onboardingApi.status();
        if (!st.completed) {
          setShowOnboarding(true);
        }
      } catch {
        // 忽略檢查失敗
      }
    })();
  }, [isAuthenticated, view]);

  // 登入後每次從雲端載入 PGP 金鑰包（唔留 localStorage；logout/session 過期後再 fetch）
  useEffect(() => {
    if (isAuthenticated) {
      pgpService.fetchKeyringFromCloud().then((cloudKey) => {
        if (cloudKey) {
          console.log('✅ 已成功自雲端同步 PGP 密文金鑰包:', cloudKey.keyId);
        }
        refreshPgp();
      });
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

      {/* 首次登入 onboarding 強制完成 2FA + PGP */}
      {showOnboarding && (
        <OnboardingWizard
          onComplete={() => {
            setShowOnboarding(false);
            refreshPgp();
          }}
        />
      )}
    </div>
  );
};

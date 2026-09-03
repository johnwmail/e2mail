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
import { ContactsPage } from './components/contacts/ContactsPage';
import { SievePage } from './components/sieve/SievePage';
import { OnboardingWizard } from './components/onboarding/OnboardingWizard';
import { Toast } from './components/ui/Toast';
import { connectEvents } from './api/sse';
import { pgpService } from './api/pgp';
import { refreshPgp } from './stores/usePgpStore';
import { onboardingApi, OnboardingStatus } from './api/onboarding';

export const App: React.FC = () => {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading, initAuth, token, logout } = useAuthStore();
  const view = useMailStore((s) => s.view);
  const composerKey = useMailStore((s) => s.composerKey);
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

  // 登入後檢查 onboarding 完成度（依 REQUIRE_2FA / REQUIRE_PGP）；未完成則顯示 wizard
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      try {
        const st = await onboardingApi.status();
        setOnboardingStatus(st);
        if (!st.completed) {
          setShowOnboarding(true);
        }
      } catch {
        // 忽略檢查失敗
      }
    })();
  }, [isAuthenticated, view]);

  // 登入後從 DB 載入 listMode（threads/messages），覆蓋本地快取，做到跨裝置一致
  const setListMode = useMailStore((s) => s.setListMode);
  useEffect(() => {
    if (!isAuthenticated) return;
    import('./api/prefs')
      .then(({ prefsApi }) => prefsApi.get('listMode'))
      .then((mode) => {
        if (mode === 'threads' || mode === 'messages') setListMode(mode);
      })
      .catch(() => {});
  }, [isAuthenticated, setListMode]);

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
        正在載入 e2Mail...
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
        ) : view === 'contacts' ? (
          <ContactsPage />
        ) : view === 'sieve' ? (
          <SievePage />
        ) : (
          <>
            <Sidebar />
            <MessageList />
            <ViewerPane />
          </>
        )}
      </div>
      {view === 'mail' && activeAccount && <Composer key={composerKey} />}

      {/* 首次登入 onboarding 強制完成 2FA + PGP（依 REQUIRE_2FA / REQUIRE_PGP） */}
      {showOnboarding && (
        <OnboardingWizard
          require2FA={onboardingStatus?.require2FA ?? true}
          requirePGP={onboardingStatus?.requirePGP ?? true}
          onComplete={() => {
            setShowOnboarding(false);
            refreshPgp();
          }}
        />
      )}

      <Toast />
    </div>
  );
};

import { useEffect, useState } from 'react';
import { Redirect, Stack, usePathname } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { onboardingApi, pgpApi } from '../../src/api';
import { useMailboxEvents } from '../../src/hooks/useMailboxEvents';
import { useAuthStore } from '../../src/stores/useAuthStore';
import { useMailboxStore } from '../../src/stores/useMailboxStore';
import { usePrefsStore } from '../../src/stores/usePrefsStore';

export default function AppGroupLayout() {
  const hydrated = usePrefsStore((s) => s.hydrated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const session = useAuthStore((s) => s.session);
  const hydrateRemotePrefs = useAuthStore((s) => s.hydrateRemotePrefs);
  const ensureAccount = useMailboxStore((s) => s.ensureAccount);
  const pathname = usePathname();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useMailboxEvents();

  useEffect(() => {
    if (isAuthenticated) {
      void hydrateRemotePrefs();
      void pgpApi().fetchKeyringFromCloud().catch(() => undefined);
    }
  }, [hydrateRemotePrefs, isAuthenticated]);

  useEffect(() => {
    if (session?.accounts) ensureAccount(session.accounts);
  }, [ensureAccount, session]);

  const statusQuery = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: () => onboardingApi().status(),
    enabled: isAuthenticated,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!isAuthenticated) {
      setOnboardingChecked(false);
      return;
    }
    if (statusQuery.data) {
      setNeedsOnboarding(!statusQuery.data.completed);
      setOnboardingChecked(true);
    } else if (statusQuery.isError) {
      setNeedsOnboarding(false);
      setOnboardingChecked(true);
    }
  }, [isAuthenticated, statusQuery.data, statusQuery.isError]);

  if (!hydrated || isLoading) return null;
  if (!isAuthenticated) return <Redirect href="/login" />;
  if (onboardingChecked && needsOnboarding && !pathname.includes('onboarding')) {
    return <Redirect href="/onboarding" />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    />
  );
}

import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { configureI18n, setLocale } from '@e2mail/shared';
import { AppQueryProvider } from '../src/providers/AppQueryProvider';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { PassphrasePrompt } from '../src/components/PassphrasePrompt';
import { ToastHost } from '../src/components/ToastHost';
import { deviceLanguage } from '../src/platform';
import { useAuthStore } from '../src/stores/useAuthStore';
import { usePrefsStore } from '../src/stores/usePrefsStore';
import { useResolvedScheme } from '../src/theme/useTheme';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const hydrate = usePrefsStore((s) => s.hydrate);
  const hydrated = usePrefsStore((s) => s.hydrated);
  const apiBaseUrl = usePrefsStore((s) => s.apiBaseUrl);
  const locale = usePrefsStore((s) => s.locale);
  const initAuth = useAuthStore((s) => s.initAuth);
  const isLoading = useAuthStore((s) => s.isLoading);
  const scheme = useResolvedScheme();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    configureI18n({ language: deviceLanguage() });
  }, []);

  useEffect(() => {
    setLocale(locale);
  }, [locale]);

  useEffect(() => {
    if (hydrated) void initAuth(apiBaseUrl);
  }, [hydrated, apiBaseUrl, initAuth]);

  useEffect(() => {
    if (hydrated && !isLoading) {
      void SplashScreen.hideAsync();
    }
  }, [hydrated, isLoading]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppQueryProvider>
          <ErrorBoundary locale={locale} scheme={scheme}>
            <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false }} />
            <PassphrasePrompt />
            <ToastHost scheme={scheme} />
          </ErrorBoundary>
        </AppQueryProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

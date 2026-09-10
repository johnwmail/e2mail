import { Redirect, Stack } from 'expo-router';
import { useAuthStore } from '../../src/stores/useAuthStore';
import { usePrefsStore } from '../../src/stores/usePrefsStore';

export default function AppGroupLayout() {
  const hydrated = usePrefsStore((s) => s.hydrated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!hydrated || isLoading) return null;
  if (!isAuthenticated) return <Redirect href="/login" />;

  return <Stack screenOptions={{ headerShown: false }} />;
}

import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useAuthStore } from '../src/stores/useAuthStore';
import { usePrefsStore } from '../src/stores/usePrefsStore';
import { useThemeTokens } from '../src/theme/useTheme';

export default function Index() {
  const hydrated = usePrefsStore((s) => s.hydrated);
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const colors = useThemeTokens();

  if (!hydrated || isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return <Redirect href={isAuthenticated ? '/(app)' : '/login'} />;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

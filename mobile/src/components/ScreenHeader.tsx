import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useT } from '../hooks/useT';
import { useThemeTokens } from '../theme/useTheme';

export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const colors = useThemeTokens();
  const t = useT();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.back')}
        onPress={onBack ?? (() => router.back())}
        style={styles.back}
      >
        <Text style={{ color: colors.primary }}>{t('common.back')}</Text>
      </Pressable>
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: colors.text }]}
        numberOfLines={1}
      >
        {title}
      </Text>
      <View style={styles.back} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    minHeight: 52,
  },
  back: { minWidth: 64, minHeight: 44, justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700' },
});

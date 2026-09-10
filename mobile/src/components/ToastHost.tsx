import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToastStore } from '../stores/useToastStore';
import { themes, type ColorSchemeName } from '../theme/tokens';

export function ToastHost({ scheme }: { scheme: ColorSchemeName }) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const insets = useSafeAreaInsets();
  const colors = themes[scheme];

  if (toasts.length === 0) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 16 }]}>
      {toasts.map((toast) => (
        <Pressable
          key={toast.id}
          accessibilityRole="button"
          onPress={() => dismiss(toast.id)}
          style={[styles.toast, { backgroundColor: colors.text }]}
        >
          <Text style={[styles.text, { color: colors.bg }]}>{toast.text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 16,
    right: 16,
    gap: 8,
  },
  toast: {
    minHeight: 44,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    justifyContent: 'center',
  },
  text: { fontSize: 14, fontWeight: '500' },
});

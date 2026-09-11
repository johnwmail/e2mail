import { Pressable, StyleSheet, Text, type PressableProps } from 'react-native';
import { useThemeTokens } from '../theme/useTheme';

export function PrimaryButton({
  label,
  disabled,
  danger,
  ...rest
}: PressableProps & { label: string; danger?: boolean }) {
  const colors = useThemeTokens();
  const bg = danger ? colors.danger : colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
      ]}
      {...rest}
    >
      <Text style={[styles.label, { color: colors.primaryText }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  label: { fontSize: 16, fontWeight: '600' },
});

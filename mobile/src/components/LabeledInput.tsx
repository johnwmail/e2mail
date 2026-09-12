import { StyleSheet, Text, TextInput, type TextInputProps } from 'react-native';
import { useThemeTokens } from '../theme/useTheme';

export function LabeledInput({
  label,
  style,
  accessibilityLabel,
  ...props
}: TextInputProps & { label: string }) {
  const colors = useThemeTokens();
  return (
    <>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        {...props}
        accessibilityLabel={accessibilityLabel ?? label}
        style={[
          styles.input,
          {
            borderColor: colors.border,
            color: colors.text,
            backgroundColor: colors.bgMuted,
          },
          style,
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    minHeight: 44,
  },
});

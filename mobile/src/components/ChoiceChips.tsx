import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemeTokens } from '../theme/useTheme';

export function ChoiceChips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
}) {
  const colors = useThemeTokens();
  return (
    <View style={styles.wrap}>
      {options.map((opt) => {
        const selected = opt.id === value;
        return (
          <Pressable
            key={opt.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.id)}
            style={[
              styles.chip,
              {
                borderColor: selected ? colors.primary : colors.border,
                backgroundColor: selected ? colors.bgMuted : colors.bg,
              },
            ]}
          >
            <Text style={{ color: colors.text }}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    justifyContent: 'center',
  },
});

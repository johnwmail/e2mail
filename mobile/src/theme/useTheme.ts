import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { themes, type ColorSchemeName, type ThemeTokens } from '../theme/tokens';
import { usePrefsStore } from '../stores/usePrefsStore';

export function useResolvedScheme(): ColorSchemeName {
  const theme = usePrefsStore((s) => s.theme);
  const system = useColorScheme();
  if (theme === 'system') return system === 'dark' ? 'dark' : 'light';
  return theme;
}

export function useThemeTokens(): ThemeTokens {
  const scheme = useResolvedScheme();
  return useMemo(() => themes[scheme], [scheme]);
}

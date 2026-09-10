export type ColorSchemeName = 'light' | 'dark';

export interface ThemeTokens {
  bg: string;
  bgMuted: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryText: string;
  danger: string;
}

/** Aligns with the web Tailwind slate/blue palette. */
export const themes: Record<ColorSchemeName, ThemeTokens> = {
  light: {
    bg: '#ffffff',
    bgMuted: '#f8fafc',
    text: '#0f172a',
    textMuted: '#475569',
    border: '#e2e8f0',
    primary: '#2563eb',
    primaryText: '#ffffff',
    danger: '#b91c1c',
  },
  dark: {
    bg: '#0f172a',
    bgMuted: '#1e293b',
    text: '#f8fafc',
    textMuted: '#94a3b8',
    border: '#334155',
    primary: '#3b82f6',
    primaryText: '#ffffff',
    danger: '#f87171',
  },
};

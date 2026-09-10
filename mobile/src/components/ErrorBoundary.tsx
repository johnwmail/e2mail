import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { themes } from '../theme/tokens';
import { translate, type AppLocale } from '../i18n';

interface Props {
  children: ReactNode;
  locale: AppLocale;
  scheme: 'light' | 'dark';
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const colors = themes[this.props.scheme];
    const t = (key: string) => translate(this.props.locale, key);
    return (
      <View style={[styles.box, { backgroundColor: colors.bg }]}>
        <Text style={[styles.title, { color: colors.text }]}>{t('error.title')}</Text>
        <Text style={[styles.detail, { color: colors.textMuted }]}>
          {this.state.error.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={() => this.setState({ error: null })}
        >
          <Text style={[styles.buttonText, { color: colors.primaryText }]}>
            {t('error.retry')}
          </Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  box: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 22, fontWeight: '700' },
  detail: { fontSize: 14 },
  button: {
    marginTop: 8,
    minHeight: 44,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
});

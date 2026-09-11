import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Redirect, router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  runCryptoSmoke,
  type CryptoSmokeResult,
  type SmokeStep,
} from '../src/crypto/smoke';
import { useThemeTokens } from '../src/theme/useTheme';

function stepLine(step: SmokeStep): string {
  return `${step.ok ? 'PASS' : 'FAIL'}  ${step.name}  (${step.ms.toFixed(1)} ms)${
    step.detail ? `\n      ${step.detail}` : ''
  }`;
}

function resultText(result: CryptoSmokeResult): string {
  const env = result.environment;
  const lines = [
    `e2Mail crypto smoke: ${result.ok ? 'PASS' : 'FAIL'}`,
    `crypto.subtle=${env.subtle} getRandomValues=${env.getRandomValues} TextEncoder=${env.textEncoder} TextDecoder=${env.textDecoder}`,
    '',
    ...result.steps.map(stepLine),
  ];
  if (result.benchmark) {
    const b = result.benchmark;
    lines.push(
      '',
      `benchmark x${b.iterations}: keygen=${b.keygenMs.toFixed(1)}ms encrypt=${b.encryptMs.toFixed(1)}ms decrypt=${b.decryptMs.toFixed(1)}ms sign=${b.signMs.toFixed(1)}ms verify=${b.verifyMs.toFixed(1)}ms`
    );
  }
  return lines.join('\n');
}

/**
 * Dev-only harness for P3.3 (on-device round-trip) and P3.7 (device timings).
 * Reachable from the home screen in `__DEV__` builds only.
 */
export default function CryptoScreen() {
  const colors = useThemeTokens();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CryptoSmokeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runCryptoSmoke({ benchmark: true, iterations: 3 }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, []);

  const share = useCallback(() => {
    if (result) void Share.share({ message: resultText(result) });
  }, [result]);

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.bg }]}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>Crypto diagnostics</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Runs OpenPGP.js through the device crypto backend (P3.3) and the send/decrypt
          benchmark (P3.7). Development builds only.
        </Text>

        <Pressable
          accessibilityRole="button"
          disabled={running}
          onPress={() => void run()}
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: colors.primary, minHeight: 44 },
            pressed && styles.pressed,
          ]}
        >
          {running ? (
            <ActivityIndicator color={colors.primaryText} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.primaryText }]}>
              Run smoke + benchmark
            </Text>
          )}
        </Pressable>

        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

        {result ? (
          <View style={styles.results}>
            <Text style={[styles.badge, { color: result.ok ? colors.primary : colors.danger }]}>
              {result.ok ? 'PASS' : 'FAIL'}
            </Text>
            <Text style={[styles.env, { color: colors.textMuted }]}>
              subtle={String(result.environment.subtle)} random=
              {String(result.environment.getRandomValues)} TextEncoder=
              {String(result.environment.textEncoder)} TextDecoder=
              {String(result.environment.textDecoder)}
            </Text>

            {result.steps.map((step) => (
              <View key={step.name} style={styles.step}>
                <Text style={[styles.stepName, { color: step.ok ? colors.text : colors.danger }]}>
                  {step.ok ? 'PASS' : 'FAIL'} · {step.name}
                </Text>
                <Text style={[styles.stepDetail, { color: colors.textMuted }]}>
                  {step.ms.toFixed(1)} ms{step.detail ? ` · ${step.detail}` : ''}
                </Text>
              </View>
            ))}

            {result.benchmark ? (
              <View style={styles.bench}>
                <Text style={[styles.stepName, { color: colors.text }]}>
                  Benchmark ×{result.benchmark.iterations}
                </Text>
                <Text style={[styles.stepDetail, { color: colors.textMuted }]}>
                  keygen {result.benchmark.keygenMs.toFixed(1)} ms · encrypt{' '}
                  {result.benchmark.encryptMs.toFixed(1)} ms · decrypt{' '}
                  {result.benchmark.decryptMs.toFixed(1)} ms · sign{' '}
                  {result.benchmark.signMs.toFixed(1)} ms · verify{' '}
                  {result.benchmark.verifyMs.toFixed(1)} ms
                </Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={share}
              style={({ pressed }) => [
                styles.button,
                { borderWidth: 1, borderColor: colors.border, minHeight: 44 },
                pressed && styles.pressed,
              ]}
            >
              <Text style={{ color: colors.primary, fontWeight: '600' }}>Share results</Text>
            </Pressable>
          </View>
        ) : null}

        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.back}>
          <Text style={{ color: colors.textMuted }}>Back</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { padding: 24, gap: 12 },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { fontSize: 14, lineHeight: 20 },
  button: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.8 },
  error: { fontSize: 14 },
  results: { gap: 10, marginTop: 6 },
  badge: { fontSize: 22, fontWeight: '800' },
  env: { fontSize: 12, fontFamily: 'monospace' },
  step: { gap: 2 },
  stepName: { fontSize: 15, fontWeight: '600' },
  stepDetail: { fontSize: 13, fontFamily: 'monospace' },
  bench: { gap: 2, marginTop: 4 },
  back: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginTop: 4,
  },
});

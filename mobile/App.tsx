import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { ApiError, createHttpClient } from '@e2mail/shared';
import { createMobilePlatform } from './src/platform';

export default function App() {
  const [baseUrl, setBaseUrl] = useState('https://mail.example.com');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const client = useMemo(() => createHttpClient(createMobilePlatform(baseUrl)), [baseUrl]);

  const probe = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const config = await client.request<Record<string, unknown>>('/server-config');
      setStatus(JSON.stringify(config, null, 2));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>e2Mail</Text>
      <Text style={styles.subtitle}>Mobile scaffold — Phase 1</Text>

      <Text style={styles.label}>Server URL</Text>
      <TextInput
        style={styles.input}
        value={baseUrl}
        onChangeText={setBaseUrl}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://mail.example.com"
      />

      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={probe}
        disabled={loading}
      >
        <Text style={styles.buttonText}>{loading ? 'Connecting…' : 'Test connection'}</Text>
      </Pressable>

      {loading ? <ActivityIndicator style={styles.spinner} /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {status ? <Text style={styles.result}>{status}</Text> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 24,
    gap: 12,
  },
  title: { fontSize: 32, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#666', marginBottom: 12 },
  label: { fontSize: 13, fontWeight: '600', color: '#333' },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  spinner: { marginTop: 12 },
  error: { marginTop: 12, color: '#b91c1c' },
  result: {
    marginTop: 12,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#111',
  },
});

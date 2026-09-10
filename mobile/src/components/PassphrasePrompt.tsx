import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { t } from '@e2mail/shared';
import {
  isBiometricAvailable,
  loadPersistedPassphrase,
  persistPassphrase,
  rememberPassphrase,
} from '../crypto/passphrase';
import {
  getPendingPassphrasePrompt,
  resolvePassphrase,
  subscribePassphrasePrompt,
} from '../crypto/passphrasePrompt';
import { useThemeTokens } from '../theme/useTheme';

/**
 * Global modal that resolves `requestPassphrase()`. Mounted once in the root
 * layout so PGP decrypt/sign flows (Phase 4) never block on a missing UI.
 */
export function PassphrasePrompt() {
  const colors = useThemeTokens();
  const pending = useSyncExternalStore(
    subscribePassphrasePrompt,
    getPendingPassphrasePrompt,
    getPendingPassphrasePrompt
  );
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const [biometric, setBiometric] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = pending !== null;
  const allowPersist = pending?.options.allowPersist ?? false;

  useEffect(() => {
    if (!visible) return;
    setValue('');
    setRemember(false);
    setError(null);
    setBusy(false);
    void isBiometricAvailable().then(setBiometric);
  }, [visible]);

  const cancel = () => resolvePassphrase(null);

  const submit = async () => {
    const passphrase = value.trim();
    if (!passphrase) {
      setError(t('pgp.passphraseRequired'));
      return;
    }
    setBusy(true);
    try {
      if (remember && allowPersist) {
        await persistPassphrase(passphrase);
      } else {
        rememberPassphrase(passphrase);
      }
      resolvePassphrase(passphrase);
    } finally {
      setBusy(false);
    }
  };

  const biometricUnlock = async () => {
    setBusy(true);
    setError(null);
    try {
      // A biometric-gated cache prompts here; a plain SecureStore item loads
      // silently. Either way an empty result means "nothing cached".
      const cached = await loadPersistedPassphrase();
      if (cached) {
        resolvePassphrase(cached);
      } else {
        setError(t('pgp.biometricFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={cancel}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { backgroundColor: colors.bg, borderColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>
            {pending?.options.title ?? t('pgp.unlockTitle')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textMuted }]}>
            {pending?.options.subtitle ?? t('pgp.unlockSubtitle')}
          </Text>

          <TextInput
            style={[
              styles.input,
              { borderColor: colors.border, color: colors.text, backgroundColor: colors.bgMuted },
            ]}
            value={value}
            onChangeText={setValue}
            placeholder={t('pgp.unlockPassphrase')}
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('pgp.unlockPassphrase')}
            onSubmitEditing={() => void submit()}
          />

          {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

          {allowPersist ? (
            <View style={styles.rememberRow}>
              <View style={styles.rememberLabels}>
                <Text style={[styles.rememberTitle, { color: colors.text }]}>
                  {t('pgp.rememberOnDevice')}
                </Text>
                <Text style={[styles.rememberHint, { color: colors.textMuted }]}>
                  {t('pgp.rememberHint')}
                </Text>
              </View>
              <Switch value={remember} onValueChange={setRemember} />
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary, minHeight: 44 },
              pressed && styles.pressed,
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.primaryText} />
            ) : (
              <Text style={[styles.primaryText, { color: colors.primaryText }]}>
                {t('pgp.unlock')}
              </Text>
            )}
          </Pressable>

          {biometric ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void biometricUnlock()}
              style={({ pressed }) => [
                styles.secondaryButton,
                { borderColor: colors.border, minHeight: 44 },
                pressed && styles.pressed,
              ]}
            >
              <Text style={{ color: colors.primary, fontWeight: '600' }}>
                {t('pgp.useBiometric')}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={cancel}
            style={styles.cancelButton}
          >
            <Text style={{ color: colors.textMuted }}>{t('pgp.unlockCancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  title: { fontSize: 20, fontWeight: '700' },
  subtitle: { fontSize: 14, lineHeight: 20 },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    minHeight: 44,
  },
  error: { fontSize: 13 },
  rememberRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rememberLabels: { flex: 1 },
  rememberTitle: { fontSize: 14, fontWeight: '600' },
  rememberHint: { fontSize: 12, marginTop: 2 },
  primaryButton: {
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButton: { alignItems: 'center', paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  pressed: { opacity: 0.8 },
});

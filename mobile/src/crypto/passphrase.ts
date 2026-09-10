import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/** SecureStore key for the optional biometric-gated passphrase cache. */
export const PASSPHRASE_KEY = 'e2Mail_pgp_passphrase';

/**
 * In-memory PGP private-key passphrase. This is the default: it lives only for
 * the process lifetime and is cleared on logout / when the key is unloaded.
 */
let memoryPassphrase: string | null = null;

export function rememberPassphrase(passphrase: string): void {
  memoryPassphrase = passphrase;
}

export function getRememberedPassphrase(): string | null {
  return memoryPassphrase;
}

export function forgetPassphrase(): void {
  memoryPassphrase = null;
}

export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const [hardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hardware && enrolled;
  } catch {
    return false;
  }
}

export type BiometricKind = 'face' | 'fingerprint' | 'iris' | 'none';

export async function biometricKind(): Promise<BiometricKind> {
  try {
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) return 'face';
    if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) return 'fingerprint';
    if (types.includes(LocalAuthentication.AuthenticationType.IRIS)) return 'iris';
    return 'none';
  } catch {
    return 'none';
  }
}

/**
 * Prompt for biometrics. Returns false when unavailable/denied. Callers should
 * fall back to a manual passphrase prompt rather than treating this as fatal.
 */
export async function authenticateWithBiometrics(promptMessage: string): Promise<boolean> {
  if (!(await isBiometricAvailable())) return false;
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}

export interface PersistPassphraseOptions {
  /** Defaults to auto-detect via `isBiometricAvailable()`. */
  biometric?: boolean;
  authenticationPrompt?: string;
}

/**
 * Optional durable cache behind the OS keystore. When biometrics are available
 * the item is written with `requireAuthentication`, so the OS prompts before the
 * passphrase is returned. The passphrase is never written in plaintext outside
 * the keystore.
 *
 * @returns `'biometric'` when gated, `'secure-store'` when only keystore-encrypted.
 */
export async function persistPassphrase(
  passphrase: string,
  options: PersistPassphraseOptions = {}
): Promise<'biometric' | 'secure-store'> {
  rememberPassphrase(passphrase);
  const useBiometric = options.biometric ?? (await isBiometricAvailable());
  const prompt = options.authenticationPrompt ?? 'Unlock your PGP key';
  await SecureStore.setItemAsync(
    PASSPHRASE_KEY,
    passphrase,
    useBiometric ? { requireAuthentication: true, authenticationPrompt: prompt } : undefined
  );
  return useBiometric ? 'biometric' : 'secure-store';
}

/**
 * Read the durable passphrase cache. Triggers the biometric prompt when the item
 * was gated. Returns null when nothing is cached or authentication was denied.
 */
export async function loadPersistedPassphrase(
  options: PersistPassphraseOptions = {}
): Promise<string | null> {
  const useBiometric = options.biometric ?? (await isBiometricAvailable());
  const prompt = options.authenticationPrompt ?? 'Unlock your PGP key';
  try {
    const value = await SecureStore.getItemAsync(
      PASSPHRASE_KEY,
      useBiometric ? { requireAuthentication: true, authenticationPrompt: prompt } : undefined
    );
    if (value) rememberPassphrase(value);
    return value;
  } catch {
    return null;
  }
}

export async function clearPersistedPassphrase(): Promise<void> {
  forgetPassphrase();
  try {
    await SecureStore.deleteItemAsync(PASSPHRASE_KEY);
  } catch {
    // Nothing cached or platform refused; in-memory copy is already gone.
  }
}

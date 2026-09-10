import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import {
  biometricKind,
  clearPersistedPassphrase,
  forgetPassphrase,
  getRememberedPassphrase,
  isBiometricAvailable,
  loadPersistedPassphrase,
  PASSPHRASE_KEY,
  persistPassphrase,
  rememberPassphrase,
} from './passphrase';

const secureStore = SecureStore as unknown as {
  __store: Map<string, string>;
  setItemAsync: jest.Mock;
  getItemAsync: jest.Mock;
  deleteItemAsync: jest.Mock;
};

describe('passphrase cache (P3.6)', () => {
  beforeEach(() => {
    forgetPassphrase();
    secureStore.__store.clear();
    jest.clearAllMocks();
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
  });

  it('keeps the passphrase in memory only by default', () => {
    rememberPassphrase('in-memory');
    expect(getRememberedPassphrase()).toBe('in-memory');
    forgetPassphrase();
    expect(getRememberedPassphrase()).toBeNull();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('reports biometric availability and kind', async () => {
    expect(await isBiometricAvailable()).toBe(true);
    expect(await biometricKind()).toBe('fingerprint');
  });

  it('persists behind biometrics and never in AsyncStorage', async () => {
    const mode = await persistPassphrase('secret');

    expect(mode).toBe('biometric');
    expect(getRememberedPassphrase()).toBe('secret');
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      PASSPHRASE_KEY,
      'secret',
      expect.objectContaining({ requireAuthentication: true })
    );
    const [, , options] = secureStore.setItemAsync.mock.calls[0];
    expect(String(options.authenticationPrompt)).toContain('PGP');
  });

  it('loads, then clears the persisted passphrase', async () => {
    await persistPassphrase('secret');
    forgetPassphrase();

    expect(await loadPersistedPassphrase()).toBe('secret');
    expect(getRememberedPassphrase()).toBe('secret');

    await clearPersistedPassphrase();
    expect(getRememberedPassphrase()).toBeNull();
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(PASSPHRASE_KEY);
  });

  it('falls back to keystore-only when biometrics are unavailable', async () => {
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(false);

    const mode = await persistPassphrase('secret');
    expect(mode).toBe('secure-store');
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(PASSPHRASE_KEY, 'secret', undefined);
  });
});

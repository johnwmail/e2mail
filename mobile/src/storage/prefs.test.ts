import AsyncStorage from '@react-native-async-storage/async-storage';
import { PREFS_KEYS, readPref, writePref, removePref } from './prefs';

describe('prefs storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('round-trips non-secret prefs in AsyncStorage', async () => {
    await writePref(PREFS_KEYS.theme, 'dark');
    expect(await readPref(PREFS_KEYS.theme)).toBe('dark');
    await removePref(PREFS_KEYS.theme);
    expect(await readPref(PREFS_KEYS.theme)).toBeNull();
  });
});

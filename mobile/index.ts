// Custom Expo Router entry: the crypto polyfill must evaluate before any
// module that imports OpenPGP.js (which reads `globalThis.crypto` at import).
import './src/crypto/polyfills';
import 'expo-router/entry';

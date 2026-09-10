import { Buffer } from '@craftzdog/react-native-buffer';
import { install } from 'react-native-quick-crypto';

/**
 * React Native / Hermes has neither `crypto.subtle` nor `TextEncoder`.
 * OpenPGP.js v6 reads `globalThis.crypto` at module load time (and throws when
 * the WebCrypto API is missing), so this module MUST run before any import of
 * `@e2mail/shared/pgp` — see `mobile/index.ts`.
 *
 * `install()` sets `global.crypto` (subtle + getRandomValues) and `global.Buffer`
 * using the native OpenSSL backend. It requires a development build / prebuild;
 * Expo Go has no native modules (P3.1). `polyfills.web.ts` overrides this with a
 * no-op on web.
 */
install();

if (typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'undefined') {
  // OpenPGP needs UTF-8 encoding. Encoding through the native Buffer keeps
  // surrogate pairs and lone surrogates correct; a JS charCode loop would not.
  class Utf8TextEncoder {
    readonly encoding = 'utf-8';

    encode(input = ''): Uint8Array {
      return new Uint8Array(Buffer.from(input, 'utf-8'));
    }

    encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
      const bytes = Buffer.from(source, 'utf-8');
      const written = Math.min(bytes.length, destination.length);
      destination.set(bytes.subarray(0, written));
      return { read: source.length, written };
    }
  }

  Object.defineProperty(globalThis, 'TextEncoder', {
    value: Utf8TextEncoder,
    configurable: true,
    writable: true,
  });
}

export {};

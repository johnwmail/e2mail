/**
 * Host abstraction for @e2mail/shared.
 *
 * The shared package must run on the web (`window`, `localStorage`, DOM `fetch`)
 * and on React Native (Hermes, `expo-secure-store`, RN `fetch`) without importing
 * either environment's globals directly. Every host provides a `Platform`.
 */

export type MaybePromise<T> = T | Promise<T>;

export interface KeyValueStore {
  getItem(key: string): MaybePromise<string | null>;
  setItem(key: string, value: string): MaybePromise<void>;
  removeItem(key: string): MaybePromise<void>;
}

export interface Platform {
  /** API origin without a trailing slash, e.g. `https://mail.example.com`. */
  apiBaseUrl: string;
  /** `fetch` implementation for the host (handles CORS on web, TLS on device). */
  fetch: typeof fetch;
  /** Persistent key/value storage: `localStorage` on web, AsyncStorage/SecureStore on device. */
  storage: KeyValueStore;
  /** BCP-47 language tag used for locale detection, e.g. `navigator.language`. */
  language?: string;
  /** Called after a 401 clears the stored session so the host can route to login. */
  onUnauthorized?: () => void;
  /** Skip session-clearing on 401 (e.g. the web login page). */
  isPublicRoute?: () => boolean;
  /** Optional translator; defaults to returning the key unchanged. */
  translate?: (key: string, vars?: Record<string, string | number>) => string;
}

/** In-memory store, useful for tests and for ephemeral sessions. */
export function createMemoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** Join a base URL with an API path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const cleanBase = base.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Browsers and Expo Web already provide `crypto.subtle`, `crypto.getRandomValues`,
 * `TextEncoder` and `TextDecoder`, so there is nothing to install. Keeping this
 * as a no-op `.web.ts` also keeps `react-native-quick-crypto` out of the web
 * bundle that `mobile.yml` validates with `expo export`.
 */
export {};

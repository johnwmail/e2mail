import { SESSION_TOKEN_KEY, type Platform } from '@e2mail/shared';

const SESSION_JSON_KEY = 'e2Mail_session';

export function createBrowserPlatform(
  translate?: Platform['translate']
): Platform {
  return {
    apiBaseUrl: '',
    fetch: (input, init) =>
      fetch(input, { ...init, credentials: init?.credentials ?? 'same-origin' }),
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => {
        localStorage.setItem(key, value);
      },
      removeItem: (key) => {
        localStorage.removeItem(key);
      },
    },
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    onUnauthorized: () => {
      localStorage.removeItem(SESSION_JSON_KEY);
      localStorage.removeItem(SESSION_TOKEN_KEY);
      window.dispatchEvent(new Event('auth:unauthorized'));
    },
    isPublicRoute: () =>
      typeof window !== 'undefined' && window.location.pathname.includes('/login'),
    translate,
  };
}

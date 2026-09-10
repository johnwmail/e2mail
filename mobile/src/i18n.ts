export type AppLocale = 'en' | 'zh-Hant';

const en: Record<string, string> = {
  'boot.loading': 'Loading…',
  'login.title': 'e2Mail',
  'login.subtitle': 'Sign in from Phase 4. For now, test the server and restore a stored session.',
  'login.serverUrl': 'Server URL',
  'login.testConnection': 'Test connection',
  'login.connecting': 'Connecting…',
  'login.signedInHint': 'A stored session is valid. Open the app.',
  'login.openApp': 'Open app',
  'home.title': 'Inbox',
  'home.placeholder': 'Mail screens start in Phase 4.',
  'home.signedInAs': 'Signed in as {email}',
  'home.noSession': 'Session restored, but /auth/me returned no email.',
  'home.logout': 'Log out',
  'home.theme': 'Theme',
  'home.theme.light': 'Light',
  'home.theme.dark': 'Dark',
  'home.theme.system': 'System',
  'error.title': 'Something went wrong',
  'error.retry': 'Try again',
};

const zhHant: Record<string, string> = {
  'boot.loading': '載入中…',
  'login.title': 'e2Mail',
  'login.subtitle': '登入畫面喺 Phase 4。而家可以測試伺服器，同恢復已儲存嘅工作階段。',
  'login.serverUrl': '伺服器網址',
  'login.testConnection': '測試連線',
  'login.connecting': '連線中…',
  'login.signedInHint': '已有有效工作階段。開啟應用程式。',
  'login.openApp': '開啟應用程式',
  'home.title': '收件箱',
  'home.placeholder': '郵件畫面由 Phase 4 開始。',
  'home.signedInAs': '已登入：{email}',
  'home.noSession': '已恢復工作階段，但 /auth/me 沒有電郵。',
  'home.logout': '登出',
  'home.theme': '主題',
  'home.theme.light': '淺色',
  'home.theme.dark': '深色',
  'home.theme.system': '跟隨系統',
  'error.title': '發生錯誤',
  'error.retry': '再試一次',
};

const catalogs: Record<AppLocale, Record<string, string>> = {
  en,
  'zh-Hant': zhHant,
};

export function localeFromTag(tag: string | undefined): AppLocale {
  if (!tag) return 'en';
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-Hant';
  return 'en';
}

export function translate(
  locale: AppLocale,
  key: string,
  vars?: Record<string, string | number>
): string {
  let out = catalogs[locale][key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value));
    }
  }
  return out;
}

import { t as sharedT } from '@e2mail/shared';

export type AppLocale = 'en' | 'zh-Hant';

const en: Record<string, string> = {
  'boot.loading': 'Loading…',
  'login.serverUrl': 'Server URL',
  'login.testConnection': 'Test connection',
  'login.connecting': 'Connecting…',
  'home.signedInAs': 'Signed in as {email}',
  'home.theme.light': 'Light',
  'home.theme.dark': 'Dark',
  'home.theme.system': 'System',
  'error.title': 'Something went wrong',
  'error.retry': 'Try again',
  'mail.folders': 'Folders',
  'mail.compose': 'Compose',
  'mail.retry': 'Retry',
  'mail.empty': 'No messages in this folder',
  'mail.loadMore': 'Load more',
  'mail.decrypt': 'Decrypt',
  'mail.allowRemoteImages': 'Load remote images',
  'mail.blockRemoteImages': 'Block remote images',
  'mail.move': 'Move',
  'mail.delete': 'Delete',
  'onboarding.secret': 'Authenticator secret',
  'onboarding.displayName': 'Display name',
  'onboarding.backupHint': 'Save these backup codes now. They will not be shown again.',
  'push.title': 'Notifications',
  'push.enabled': 'Push notifications',
  'push.quietHint': 'Quiet hours (24h, device timezone). Leave blank to always notify.',
  'push.quietStart': 'Quiet start',
  'push.quietEnd': 'Quiet end',
  'push.registered': 'This device is registered for push.',
  'push.needDevice': 'Push needs a development build on a physical device.',
  'push.saved': 'Saved.',
  'common.save': 'Save',
  'common.back': 'Back',
};

const zhHant: Record<string, string> = {
  'boot.loading': '載入中…',
  'login.serverUrl': '伺服器網址',
  'login.testConnection': '測試連線',
  'login.connecting': '連線中…',
  'home.signedInAs': '已登入：{email}',
  'home.theme.light': '淺色',
  'home.theme.dark': '深色',
  'home.theme.system': '跟隨系統',
  'error.title': '發生錯誤',
  'error.retry': '再試一次',
  'mail.folders': '資料夾',
  'mail.compose': '撰寫',
  'mail.retry': '重試',
  'mail.empty': '此資料夾沒有郵件',
  'mail.loadMore': '載入更多',
  'mail.decrypt': '解密',
  'mail.allowRemoteImages': '載入遠端圖片',
  'mail.blockRemoteImages': '封鎖遠端圖片',
  'mail.move': '移動',
  'mail.delete': '刪除',
  'onboarding.secret': '驗證器密鑰',
  'onboarding.displayName': '顯示名稱',
  'onboarding.backupHint': '請立即儲存這些備用代碼，之後不會再顯示。',
  'push.title': '通知',
  'push.enabled': '推播通知',
  'push.quietHint': '勿擾時段（24 小時制，跟裝置時區）。留空即隨時通知。',
  'push.quietStart': '開始時間',
  'push.quietEnd': '結束時間',
  'push.registered': '此裝置已登記推播。',
  'push.needDevice': '推播需要實體裝置上的 development build。',
  'push.saved': '已儲存。',
  'common.save': '儲存',
  'common.back': '返回',
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
  const local = catalogs[locale][key] ?? catalogs.en[key];
  if (local) {
    let out = local;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        out = out.replaceAll(`{${name}}`, String(value));
      }
    }
    return out;
  }
  return sharedT(key, vars);
}

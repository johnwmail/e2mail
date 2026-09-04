// Dev-only visual harness for the Settings page (see preview.html).
// Runs without the Go backend: seeds a fake session and answers /api/* with canned data.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from './components/settings/SettingsPage';
import { Toast } from './components/ui/Toast';
import { useAuthStore } from './stores/useAuthStore';
import { useMailStore } from './stores/useMailStore';
import { applyDocumentLang } from './i18n';
import { Account, Session } from './types/api';
import './index.css';

const account = (over: Partial<Account>): Account => ({
  id: 'acc-1',
  label: 'Work',
  email: 'ada@example.com',
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapUseTls: true,
  imapAllowInsecureTls: false,
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpUseTls: true,
  smtpAllowInsecureTls: false,
  sieveHost: '',
  sievePort: 4190,
  sieveUseTls: true,
  sieveAllowInsecureTls: false,
  username: 'ada@example.com',
  isDefault: true,
  sortOrder: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

const accounts: Account[] = [
  account({}),
  account({
    id: 'acc-2',
    label: 'Personal',
    email: 'ada@personal.example',
    username: 'ada@personal.example',
    isDefault: false,
    sortOrder: 1,
  }),
];

const session: Session = {
  id: 'sess-preview',
  email: 'ada@example.com',
  username: 'ada@example.com',
  accounts,
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
};

const SIEVE_SCRIPT = `require ["fileinto"];
# rule:[Newsletters]
if header :contains "From" "noreply" {
  fileinto "Ads";
}
`;

// Append ?2fa=on to preview the already-enabled state.
const twoFaEnabled = new URLSearchParams(window.location.search).get('2fa') === 'on';

const routes: Array<[RegExp, unknown]> = [
  [/\/api\/server-config$/, { ldapEnabled: true, defaults: {} }],
  [/\/api\/2fa\/status$/, { enabled: twoFaEnabled }],
  [
    /\/api\/2fa\/setup$/,
    {
      secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      otpauthUrl: 'otpauth://totp/e2Mail:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=e2Mail',
      issuer: 'e2Mail',
      account: 'ada@example.com',
    },
  ],
  [
    /\/api\/2fa\/enable$/,
    {
      enabled: true,
      backupCodes: ['A1B2-C3D4', 'E5F6-0718', '2939-4A5B', '6C7D-8E9F', '0A1B-2C3D', '4E5F-6071'],
    },
  ],
  [/\/api\/accounts$/, accounts],
  [/\/api\/accounts\/[^/]+\/folders\/prefs$/, {}],
  [/\/api\/accounts\/[^/]+\/folders\/order$/, []],
  [/\/api\/prefs\//, { key: 'preview', value: '' }],
  [/\/api\/pgp\/keyring$/, null],
  [
    /\/api\/pgp\/contacts$/,
    [
      { email: 'grace@example.com', name: 'Grace Hopper', publicKeyArmored: '', fingerprint: 'A1B2 C3D4 E5F6 0718 2939' },
      { email: 'alan@example.com', name: 'Alan Turing', publicKeyArmored: '', fingerprint: '99AA BBCC DDEE FF00 1122' },
    ],
  ],
  [/\/api\/sieve\/capability/, { fileinto: '', copy: '' }],
  [/\/api\/sieve\/scripts\/[^/?]+/, { name: 'newsletters', content: SIEVE_SCRIPT }],
  [/\/api\/sieve\/scripts/, [{ name: 'newsletters', active: true }, { name: 'archive-old', active: false }]],
  [/\/api\/mail\/folders/, [{ name: 'INBOX', specialUse: 'inbox', delimiter: '/', unreadCount: 3 }]],
];

const originalFetch = window.fetch.bind(window);

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/api/')) return originalFetch(input as RequestInfo, init);

  const match = routes.find(([pattern]) => pattern.test(url));
  const body = match
    ? { success: true, data: match[1] }
    : { success: false, error: `preview: no stub for ${url}` };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof window.fetch;

localStorage.setItem('e2Mail_token', 'preview-token');
localStorage.setItem('e2Mail_session', JSON.stringify(session));

useAuthStore.setState({ token: 'preview-token', session, isAuthenticated: true, isLoading: false });
useMailStore.setState({ view: 'settings', settingsSection: 'security', activeAccountId: accounts[0].id });

applyDocumentLang();

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

// Mirrors the theme effect that normally lives in App.
const media = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  const theme = useMailStore.getState().theme;
  document.documentElement.classList.toggle(
    'dark',
    theme === 'dark' || (theme === 'system' && media.matches)
  );
};
useMailStore.subscribe(applyTheme);
media.addEventListener('change', applyTheme);
applyTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="h-[100dvh] w-screen flex flex-col overflow-hidden bg-slate-50 dark:bg-slate-950">
        <div className="flex-1 flex overflow-hidden relative">
          <SettingsPage />
        </div>
        <Toast />
      </div>
    </QueryClientProvider>
  </React.StrictMode>
);

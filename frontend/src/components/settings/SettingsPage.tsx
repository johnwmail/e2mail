import React from 'react';
import {
  ArrowLeft,
  Globe,
  KeyRound,
  Mail,
  Monitor,
  Moon,
  Palette,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useAuthStore } from '../../stores/useAuthStore';
import {
  SettingsSection,
  ThemePreference,
  useMailStore,
} from '../../stores/useMailStore';
import { LOCALES, Locale, useI18n } from '../../i18n';
import { prefsApi } from '../../api/prefs';
import { AccountsPage } from '../accounts/AccountsPage';
import { PgpKeyModal } from '../mail/PgpKeyModal';
import { SecurityTab } from '../mail/SecurityTab';
import { SievePage } from '../sieve/SievePage';

const sectionMeta: Array<{
  id: SettingsSection;
  labelKey: string;
  hintKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'security', labelKey: 'settings.security', hintKey: 'settings.securityHint', icon: ShieldCheck },
  { id: 'pgp', labelKey: 'settings.pgp', hintKey: 'settings.pgpHint', icon: KeyRound },
  { id: 'accounts', labelKey: 'settings.accounts', hintKey: 'settings.accountsHint', icon: Mail },
  { id: 'sieve', labelKey: 'settings.sieve', hintKey: 'settings.sieveHint', icon: SlidersHorizontal },
  { id: 'appearance', labelKey: 'settings.appearance', hintKey: 'settings.appearanceHint', icon: Palette },
];

const themeMeta: Array<{
  id: ThemePreference;
  labelKey: string;
  hintKey: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'system', labelKey: 'settings.themeSystem', hintKey: 'settings.themeSystemHint', icon: Monitor },
  { id: 'light', labelKey: 'settings.themeLight', hintKey: 'settings.themeLightHint', icon: Sun },
  { id: 'dark', labelKey: 'settings.themeDark', hintKey: 'settings.themeDarkHint', icon: Moon },
];

const AppearanceSettings: React.FC = () => {
  const { t, locale, setLocale } = useI18n();
  const theme = useMailStore((s) => s.theme);
  const setTheme = useMailStore((s) => s.setTheme);
  const listMode = useMailStore((s) => s.listMode);
  const setListMode = useMailStore((s) => s.setListMode);

  const changeLocale = (next: Locale) => {
    setLocale(next);
    void prefsApi.set('locale', next).catch(() => {});
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl p-4 md:p-6 space-y-6">
        <section>
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('settings.language')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('settings.languageHint')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
            {LOCALES.map((option) => {
              const selected = locale === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => changeLocale(option.id)}
                  aria-pressed={selected}
                  className={`min-h-16 p-3 rounded-xl border text-left transition ${
                    selected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 ring-1 ring-blue-500'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Globe className={`w-4 h-4 ${selected ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500'}`} />
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{option.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="pt-6 border-t border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('settings.theme')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('settings.themeHint')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
            {themeMeta.map((option) => {
              const Icon = option.icon;
              const selected = theme === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setTheme(option.id)}
                  aria-pressed={selected}
                  className={`min-h-20 p-3 rounded-xl border text-left transition ${
                    selected
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 ring-1 ring-blue-500'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={`w-4 h-4 ${selected ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500'}`} />
                    <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{t(option.labelKey)}</span>
                  </div>
                  <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">{t(option.hintKey)}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="pt-6 border-t border-slate-200 dark:border-slate-800">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{t('settings.list')}</h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('settings.listHint')}</p>
          <div className="mt-4 inline-flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl">
            {([
              ['messages', 'settings.listMessages'],
              ['threads', 'settings.listThreads'],
            ] as const).map(([value, labelKey]) => (
              <button
                key={value}
                type="button"
                onClick={() => setListMode(value)}
                aria-pressed={listMode === value}
                className={`min-h-10 px-4 py-2 rounded-lg text-xs font-semibold transition ${
                  listMode === value
                    ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

export const SettingsPage: React.FC = () => {
  const { t } = useI18n();
  const session = useAuthStore((s) => s.session);
  const section = useMailStore((s) => s.settingsSection);
  const setSection = useMailStore((s) => s.setSettingsSection);
  const setView = useMailStore((s) => s.setView);
  const current = sectionMeta.find((item) => item.id === section) ?? sectionMeta[0];

  const content = (() => {
    switch (section) {
      case 'pgp':
        return <PgpKeyModal embedded />;
      case 'accounts':
        return <AccountsPage embedded />;
      case 'sieve':
        return <SievePage embedded onOpenAccounts={() => setSection('accounts')} />;
      case 'appearance':
        return <AppearanceSettings />;
      case 'security':
      default:
        return (
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl p-4 md:p-6">
              <SecurityTab sessionEmail={session?.email} />
            </div>
          </div>
        );
    }
  })();

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <header className="shrink-0 flex items-center gap-3 px-3 md:px-5 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button
          type="button"
          onClick={() => setView('mail')}
          className="w-10 h-10 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          aria-label={t('settings.backToMail')}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <Settings className="w-5 h-5 text-blue-600 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-sm md:text-base font-bold">{t('settings.title')}</h1>
            <p className="hidden sm:block text-[11px] text-slate-500 dark:text-slate-400 truncate">{session?.email}</p>
          </div>
        </div>
      </header>

      <nav className="lg:hidden shrink-0 flex gap-1 px-2 py-2 overflow-x-auto border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900" aria-label={t('settings.navLabel')}>
        {sectionMeta.map((item) => {
          const Icon = item.icon;
          const selected = section === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`shrink-0 min-h-10 px-3 flex items-center gap-1.5 rounded-lg text-xs font-semibold transition ${
                selected
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t(item.labelKey)}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 flex">
        <aside className="hidden lg:block w-64 shrink-0 p-3 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="space-y-1">
            {sectionMeta.map((item) => {
              const Icon = item.icon;
              const selected = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full min-h-14 px-3 py-2.5 flex items-start gap-3 rounded-xl text-left transition ${
                    selected
                      ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                  }`}
                >
                  <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${selected ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`} />
                  <span>
                    <span className="block text-xs font-bold">{t(item.labelKey)}</span>
                    <span className="block mt-0.5 text-[10px] font-normal text-slate-500 dark:text-slate-400">{t(item.hintKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          <div className="hidden lg:block shrink-0 px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <h2 className="text-base font-bold">{t(current.labelKey)}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t(current.hintKey)}</p>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">{content}</div>
        </section>
      </div>
    </main>
  );
};

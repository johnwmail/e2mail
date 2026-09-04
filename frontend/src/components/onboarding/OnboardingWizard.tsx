import React, { useState, useEffect, useRef } from 'react';
import {
  Shield,
  Key,
  Loader2,
  Lock,
  Check,
  AlertCircle,
  Copy,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { twoFApi } from '../../api/2fa';
import { pgpService, fileToPrivateKeyArmor } from '../../api/pgp';
import { refreshPgp } from '../../stores/usePgpStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { useMailStore } from '../../stores/useMailStore';
import { useI18n } from '../../i18n';

type Step = '2fa' | 'pgp' | 'done';

export const OnboardingWizard: React.FC<{
  require2FA?: boolean;
  requirePGP?: boolean;
  onComplete: () => void;
}> = ({ require2FA = true, requirePGP = true, onComplete }) => {
  const { t } = useI18n();
  const { session } = useAuthStore();
  const setView = useMailStore((s) => s.setView);
  const [step, setStep] = useState<Step>(() => {
    if (!require2FA) return requirePGP ? 'pgp' : 'done';
    return '2fa';
  });

  // 2FA state
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [issuer, setIssuer] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState('');

  // PGP state
  const [pgpName, setPgpName] = useState('');
  const [pgpPassphrase, setPgpPassphrase] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importedArmored, setImportedArmored] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const importFileRef = useRef<HTMLInputElement | null>(null);

  const handleImportFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const armored = await fileToPrivateKeyArmor(file);
      setImportedArmored(armored);
      setMsg(null);
    } catch (err: any) {
      setMsg({ type: 'error', text: t('onboarding.readFailed', { error: err?.message || err }) });
    } finally {
      e.target.value = '';
    }
  };

  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // 自動先生成 2FA setup / QR（若 2FA 已啟用則跳至 PGP step）
  useEffect(() => {
    if (step !== '2fa') return;
    (async () => {
      try {
        const status = await twoFApi.getStatus();
        if (status.enabled) {
          setStep(requirePGP ? 'pgp' : 'done');
          return;
        }
        setLoading(true);
        const res = await twoFApi.setup();
        setSecret(res.secret);
        setOtpauthUrl(res.otpauthUrl);
        setIssuer(res.issuer);
        setQrDataUrl(res.otpauthUrl);
      } catch (e: any) {
        setMsg({ type: 'error', text: t('onboarding.setupFailed', { error: e?.message || e }) });
      } finally {
        setLoading(false);
      }
    })();
  }, [step]);

  const handleEnable2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || code.length !== 6) {
      setMsg({ type: 'error', text: t('onboarding.needCode') });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const res = await twoFApi.enable(secret, code);
      setBackupCodes(res.backupCodes);
      setStep(requirePGP ? 'pgp' : 'done');
      setMsg(null);
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || t('onboarding.enableFailed') });
    } finally {
      setLoading(false);
    }
  };

  const handleGeneratePgp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.email) return;
    if (!pgpPassphrase) {
      setMsg({ type: 'error', text: t('onboarding.needPassphrase') });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await pgpService.generateKey(pgpName || 'User', session.email, pgpPassphrase);
      refreshPgp();
      finishOnboarding();
    } catch (e: any) {
      setMsg({ type: 'error', text: t('onboarding.generateFailed', { error: e?.message || e }) });
    } finally {
      setLoading(false);
    }
  };

  const handleImportPgp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importedArmored.trim()) {
      setMsg({ type: 'error', text: t('onboarding.needPrivateBlock') });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await pgpService.importPersonalKey(importedArmored.trim(), undefined, importPassphrase);
      refreshPgp();
      finishOnboarding();
    } catch (e: any) {
      setMsg({ type: 'error', text: t('onboarding.importFailed', { error: e?.message || e }) });
    } finally {
      setLoading(false);
    }
  };

  const finishOnboarding = () => {
    setStep('done');
    setMsg(null);
  };

  const handleDone = () => {
    setView('mail');
    onComplete();
  };

  const copyOtpauth = async () => {
    try {
      await navigator.clipboard.writeText(otpauthUrl);
    } catch {
      // ignore
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/70 backdrop-blur-sm overflow-y-auto">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[92vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* 頂部 */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <div className="flex items-center gap-2 text-slate-900 dark:text-white font-bold text-base">
            <Shield className="w-5 h-5 text-blue-600" />
            {t('onboarding.title')}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t('onboarding.intro')}
          </p>
          <div className="flex gap-4 mt-3 text-[11px] font-semibold">
            <span className={step === '2fa' ? 'text-blue-600' : 'text-slate-400'}>{t('onboarding.step2fa')}</span>
            <span className={step === 'pgp' || step === 'done' ? 'text-blue-600' : 'text-slate-400'}>{t('onboarding.stepPgp')}</span>
          </div>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {/* STEP 1: 2FA */}
          {step === '2fa' && (
            <form onSubmit={handleEnable2FA} className="space-y-4">
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-blue-50 border border-blue-200/60">
                <Lock className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                <div className="text-xs text-blue-800 leading-relaxed">
                  <div className="font-bold mb-0.5">{t('onboarding.twoFaTitle')}</div>
                  {t('onboarding.twoFaHint')}
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center p-8 text-slate-400 text-xs">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> {t('onboarding.generatingCode')}
                </div>
              ) : (
                <>
                  {qrDataUrl && (
                    <div className="flex justify-center p-3 bg-slate-50 rounded-xl">
                      <QRCodeCanvas value={otpauthUrl} size={180} />
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-slate-500">{t('onboarding.orEnterSecret')}</span>
                    <code className="font-mono text-slate-700 bg-slate-100 px-2 py-0.5 rounded">{secret}</code>
                    <button type="button" onClick={copyOtpauth} className="text-blue-600 hover:underline" aria-label={t('common.copy')}>
                      <Copy className="w-3.5 h-3.5 inline" />
                    </button>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">{t('security.sixDigit')}</label>
                <input
                  type="text"
                  required
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••"
                  className="w-full px-3.5 py-3 text-sm text-center tracking-[0.5em] font-mono bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-sky-400"
                />
              </div>

              {msg && (
                <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${msg.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
                  {msg.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                  {msg.text}
                </div>
              )}

              <button type="submit" disabled={loading} className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition disabled:opacity-50">
                {loading ? t('onboarding.verifying') : t('onboarding.verifyContinue')}
              </button>
            </form>
          )}

          {/* STEP 2: PGP */}
          {step === 'pgp' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200/60">
                <Shield className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="text-xs text-emerald-800 leading-relaxed">
                  <div className="font-bold mb-0.5">{t('onboarding.twoFaEnabled')}</div>
                  {t('onboarding.backupCodesSave')}
                </div>
              </div>

              {backupCodes.length > 0 && (
                <div className="p-3.5 bg-slate-50 rounded-xl grid grid-cols-2 gap-2 text-[11px] font-mono text-slate-700">
                  {backupCodes.map((c) => (
                    <span key={c}>{c}</span>
                  ))}
                </div>
              )}

              <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
                <div className="flex items-center gap-2 mb-3 text-xs font-bold text-slate-700">
                  <Key className="w-4 h-4 text-blue-600" />
                  {t('onboarding.setupPgp')}
                </div>

                {!showImport ? (
                  <form onSubmit={handleGeneratePgp} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">{t('pgp.keyName')}</label>
                      <input
                        type="text"
                        value={pgpName}
                        onChange={(e) => setPgpName(e.target.value)}
                        placeholder="Your Name"
                        className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">
                        {t('pgp.passphrase')} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="password"
                        required
                        value={pgpPassphrase}
                        onChange={(e) => setPgpPassphrase(e.target.value)}
                        placeholder={t('onboarding.passphrasePlaceholder')}
                        className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400"
                      />
                      <p className="mt-1 text-[10px] text-slate-400">{t('onboarding.passphraseHint')}</p>
                    </div>

                    {msg && (
                      <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${msg.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
                        {msg.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                        {msg.text}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={loading} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">
                        {loading ? t('onboarding.generating') : t('onboarding.generateFinish')}
                      </button>
                      <button type="button" onClick={() => setShowImport(true)} className="px-3 py-2.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50">
                        {t('onboarding.importExisting')}
                      </button>
                    </div>
                  </form>
                ) : (
                  <form onSubmit={handleImportPgp} className="space-y-3">
                    <div className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => importFileRef.current?.click()}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        {t('pgp.chooseAsc')}
                      </button>
                      <input
                        ref={importFileRef}
                        type="file"
                        accept=".asc,.pub,.gpg,.key,.txt"
                        onChange={handleImportFileUpload}
                        className="hidden"
                      />
                    </div>
                    <textarea
                      value={importedArmored}
                      onChange={(e) => setImportedArmored(e.target.value)}
                      rows={6}
                      placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                      className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400"
                    />
                    <input
                      type="password"
                      value={importPassphrase}
                      onChange={(e) => setImportPassphrase(e.target.value)}
                      placeholder={t('onboarding.importPassphrase')}
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400"
                    />
                    {msg && (
                      <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${msg.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
                        {msg.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                        {msg.text}
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={loading} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">
                        {loading ? t('onboarding.importing') : t('onboarding.importFinish')}
                      </button>
                      <button type="button" onClick={() => setShowImport(false)} className="px-3 py-2.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">
                        {t('pgp.backToGenerate')}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* STEP done */}
          {step === 'done' && (
            <div className="flex flex-col items-center text-center py-8 space-y-4">
              <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
                <Check className="w-8 h-8 text-emerald-600" />
              </div>
              <div className="text-sm font-bold text-slate-900 dark:text-white">{t('onboarding.completeTitle')}</div>
              <p className="text-xs text-slate-500">{t('onboarding.allSet')}</p>
              <button onClick={handleDone} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition">
                {t('onboarding.enterMailbox')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

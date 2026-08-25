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

type Step = '2fa' | 'pgp' | 'done';

export const OnboardingWizard: React.FC<{
  require2FA?: boolean;
  requirePGP?: boolean;
  onComplete: () => void;
}> = ({ require2FA = true, requirePGP = true, onComplete }) => {
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
      setMsg({ type: 'error', text: '讀取檔案失敗: ' + (err?.message || err) });
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
        setMsg({ type: 'error', text: '2FA 設定失敗: ' + (e?.message || e) });
      } finally {
        setLoading(false);
      }
    })();
  }, [step]);

  const handleEnable2FA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code || code.length !== 6) {
      setMsg({ type: 'error', text: '請輸入 Authenticator App 顯示嘅 6 位數驗證碼' });
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
      setMsg({ type: 'error', text: e?.message || '2FA 啟用失敗' });
    } finally {
      setLoading(false);
    }
  };

  const handleGeneratePgp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.email) return;
    if (!pgpPassphrase) {
      setMsg({ type: 'error', text: '請設定專用保護密碼 (Passphrase)' });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await pgpService.generateKey(pgpName || 'User', session.email, pgpPassphrase);
      refreshPgp();
      finishOnboarding();
    } catch (e: any) {
      setMsg({ type: 'error', text: '生成 PGP 金鑰失敗: ' + (e?.message || e) });
    } finally {
      setLoading(false);
    }
  };

  const handleImportPgp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importedArmored.trim()) {
      setMsg({ type: 'error', text: '請貼上 PGP PRIVATE KEY 區塊' });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      await pgpService.importPersonalKey(importedArmored.trim(), undefined, importPassphrase);
      refreshPgp();
      finishOnboarding();
    } catch (e: any) {
      setMsg({ type: 'error', text: '導入私鑰失敗: ' + (e?.message || e) });
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
            安全設定
          </div>
          <p className="text-xs text-slate-500 mt-1">
            為保護你嘅帳號，首次登入需要完成以下兩步：
          </p>
          <div className="flex gap-4 mt-3 text-[11px] font-semibold">
            <span className={step === '2fa' ? 'text-blue-600' : 'text-slate-400'}>1. 兩步驟驗證</span>
            <span className={step === 'pgp' || step === 'done' ? 'text-blue-600' : 'text-slate-400'}>2. PGP 金鑰</span>
          </div>
        </div>

        <div className="p-6 overflow-y-auto flex-1 space-y-4">
          {/* STEP 1: 2FA */}
          {step === '2fa' && (
            <form onSubmit={handleEnable2FA} className="space-y-4">
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-blue-50 border border-blue-200/60">
                <Lock className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
                <div className="text-xs text-blue-800 leading-relaxed">
                  <div className="font-bold mb-0.5">兩步驟驗證 (2FA / TOTP)</div>
                  使用 Authenticator App（如 Google Authenticator / 1Password）掃描下面 QR 碼，然後輸入 App 顯示嘅 6 位驗證碼。
                </div>
              </div>

              {loading ? (
                <div className="flex items-center justify-center p-8 text-slate-400 text-xs">
                  <Loader2 className="w-5 h-5 animate-spin mr-2" /> 正在產生驗證碼...
                </div>
              ) : (
                <>
                  {qrDataUrl && (
                    <div className="flex justify-center p-3 bg-slate-50 rounded-xl">
                      <QRCodeCanvas value={otpauthUrl} size={180} />
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-slate-500">或手動輸入 Secret:</span>
                    <code className="font-mono text-slate-700 bg-slate-100 px-2 py-0.5 rounded">{secret}</code>
                    <button type="button" onClick={copyOtpauth} className="text-blue-600 hover:underline">
                      <Copy className="w-3.5 h-3.5 inline" />
                    </button>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">6 位驗證碼</label>
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
                {loading ? '驗證中...' : '驗證並繼續'}
              </button>
            </form>
          )}

          {/* STEP 2: PGP */}
          {step === 'pgp' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-3.5 rounded-xl bg-emerald-50 border border-emerald-200/60">
                <Shield className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="text-xs text-emerald-800 leading-relaxed">
                  <div className="font-bold mb-0.5">2FA 已啟用</div>
                  保存以下備份碼（一次性使用，遺失可重新產生）—— 請妥善保管，用嚟喺 Authenticator 失效時登入。
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
                  設定 PGP 端到端加密金鑰
                </div>

                {!showImport ? (
                  <form onSubmit={handleGeneratePgp} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700 mb-1">金鑰名稱 (Name)</label>
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
                        專用保護密碼 (Passphrase) <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="password"
                        required
                        value={pgpPassphrase}
                        onChange={(e) => setPgpPassphrase(e.target.value)}
                        placeholder="加密私鑰用（唔係登入密碼）"
                        className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-sky-400"
                      />
                      <p className="mt-1 text-[10px] text-slate-400">解密/簽名時需輸入此密碼；請緊記，遺失將無法解密。</p>
                    </div>

                    {msg && (
                      <div className={`p-3 rounded-lg text-xs flex items-center gap-2 ${msg.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>
                        {msg.type === 'error' ? <AlertCircle className="w-4 h-4 shrink-0" /> : <Check className="w-4 h-4 shrink-0" />}
                        {msg.text}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={loading} className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50">
                        {loading ? '生成中...' : '生成並完成'}
                      </button>
                      <button type="button" onClick={() => setShowImport(true)} className="px-3 py-2.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50">
                        匯入既有私鑰
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
                        選擇 .asc 檔案
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
                      placeholder="私鑰 Passphrase（若私鑰已加密需輸入；留空=未加密）"
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
                        {loading ? '導入中...' : '導入並完成'}
                      </button>
                      <button type="button" onClick={() => setShowImport(false)} className="px-3 py-2.5 text-xs text-slate-500 border border-slate-200 rounded-lg hover:bg-slate-50">
                        返回生成
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
              <div className="text-sm font-bold text-slate-900 dark:text-white">安全設定完成！</div>
              <p className="text-xs text-slate-500">2FA 同 PGP 金鑰都設定好晒，而家可以開始用你嘅郵件。</p>
              <button onClick={handleDone} className="px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold transition">
                進入信箱
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

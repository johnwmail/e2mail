import React, { useState, useCallback, useEffect } from 'react';
import {
  ShieldCheck,
  ShieldOff,
  Loader2,
  KeyRound,
  Check,
  AlertCircle,
  Copy,
  RefreshCcw,
  Smartphone,
  Eye,
  EyeOff,
  Lock,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { twoFApi } from '../../api/2fa';
import { authApi } from '../../api/auth';
import { TwoFASetupResponse } from '../../types/api';

interface SecurityTabProps {
  sessionEmail?: string;
}

// ChangePasswordSection 經 ldapd 變更登入密碼（僅在伺服器 LDAP_ENABLED 時顯示）。
// 設計見 repo 根目錄 LDAP.md：後端驗證舊密碼 → 改 ldapd → re-wrap 本地 DEK，當前 session 不會被登出。
const ChangePasswordSection: React.FC = () => {
  const [enabled, setEnabled] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/server-config')
      .then((r) => r.json())
      .then((data) => setEnabled(!!data?.success && !!data?.data?.ldapEnabled))
      .catch(() => setEnabled(false));
  }, []);

  if (!enabled) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (newPw.length < 8) {
      setMsg({ type: 'error', text: '新密碼至少 8 個字元' });
      return;
    }
    if (newPw !== confirmPw) {
      setMsg({ type: 'error', text: '新密碼與確認密碼不一致' });
      return;
    }
    if (newPw === oldPw) {
      setMsg({ type: 'error', text: '新密碼與舊密碼相同' });
      return;
    }
    setSubmitting(true);
    try {
      await authApi.changePassword(oldPw, newPw, confirmPw);
      setMsg({ type: 'success', text: '密碼已變更。你嘅加密資料已用新密碼重新包裝，目前登入不會被登出。' });
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || '密碼變更失敗，請重試' });
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2">
        <Lock className="w-4 h-4 text-slate-500 shrink-0" />
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">變更登入密碼</h4>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        新密碼會同步到你郵件伺服器嘅 LDAP 帳戶（IMAP/SMTP 登入密碼會一併變更），並即時重新包裝你嘅本地加密資料。
      </p>

      {msg && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            msg.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {msg.type === 'success' ? (
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          )}
          <span className="break-all">{msg.text}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div>
            <label htmlFor="cp-old" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              舊密碼
            </label>
            <input
              id="cp-old"
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={oldPw}
              onChange={(e) => setOldPw(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="cp-new" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              新密碼（至少 8 字）
            </label>
            <input
              id="cp-new"
              type={showPw ? 'text' : 'password'}
              required
              minLength={8}
              autoComplete="new-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="cp-confirm" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              確認新密碼
            </label>
            <input
              id="cp-confirm"
              type={showPw ? 'text' : 'password'}
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 w-full sm:w-auto"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            變更密碼
          </button>
          <button
            type="button"
            onClick={() => setShowPw(!showPw)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition px-1 py-1 min-h-[40px] sm:min-h-0"
          >
            {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPw ? '隱藏密碼' : '顯示密碼'}
          </button>
        </div>
      </form>
    </div>
  );
};

export const SecurityTab: React.FC<SecurityTabProps> = ({ sessionEmail }) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 啟用流程狀態
  const [setup, setSetup] = useState<TwoFASetupResponse | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);

  // 停用 / 重新生成備份碼驗證
  const [actionCode, setActionCode] = useState('');
  const [disableMode, setDisableMode] = useState(false);
  const [regenerateMode, setRegenerateMode] = useState(false);
  const [showActionCode, setShowActionCode] = useState(false);

  // 沿用舊 2FA（手動輸入 MYOLD2FA...）
  const [useCustom, setUseCustom] = useState(false);
  const [customSecret, setCustomSecret] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const res = await twoFApi.getStatus();
      setStatus(res.enabled);
    } catch {
      setStatus(false);
    }
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleSetup = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const secretToUse = useCustom ? customSecret.trim().toUpperCase() : undefined;
      if (useCustom && !secretToUse) {
        setMsg({ type: 'error', text: '請輸入舊 2FA secret（MYOLD2FA...）' });
        setLoading(false);
        return;
      }
      const res = await twoFApi.setup(secretToUse);
      setSetup(res);
      setBackupCodes(null);
      setVerifyCode('');
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || '無法開始設定兩步驟驗證' });
    } finally {
      setLoading(false);
    }
  };

  const handleEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setup || !verifyCode.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await twoFApi.enable(setup.secret, verifyCode.trim());
      setBackupCodes(res.backupCodes);
      setStatus(true);
      setMsg({ type: 'success', text: '兩步驟驗證已成功啟用！請立即保存下方備份碼。' });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || '驗證碼錯誤，請重試' });
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionCode.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      await twoFApi.disable(actionCode.trim());
      setStatus(false);
      setActionCode('');
      setDisableMode(false);
      setMsg({ type: 'success', text: '兩步驟驗證已停用。' });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || '驗證碼錯誤，請重試' });
    } finally {
      setLoading(false);
    }
  };

  const handleRegenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!actionCode.trim()) return;
    setLoading(true);
    setMsg(null);
    try {
      const res = await twoFApi.regenerateBackupCodes(actionCode.trim());
      setBackupCodes(res.backupCodes);
      setRegenerateMode(false);
      setActionCode('');
      setMsg({ type: 'success', text: '備份碼已重新生成，舊碼即時作廢。請保存新備份碼！' });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || '驗證碼錯誤，請重試' });
    } finally {
      setLoading(false);
    }
  };

  const handleCopyBackupCodes = () => {
    if (!backupCodes) return;
    navigator.clipboard.writeText(backupCodes.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const cancelSetup = () => {
    setSetup(null);
    setVerifyCode('');
    setBackupCodes(null);
    setMsg(null);
  };

  return (
    <div className="space-y-5">
      {/* 提示訊息 */}
      {msg && (
        <div
          className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
            msg.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {msg.type === 'success' ? (
            <Check className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          )}
          <span className="break-all">{msg.text}</span>
        </div>
      )}

      {status === null ? (
        <div className="flex items-center justify-center py-10 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : backupCodes ? (
        /* 啟用完成 → 顯示備份碼 */
        <div className="space-y-4">
          <div className="p-4 bg-emerald-50/70 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800/60">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound className="w-4 h-4 text-emerald-600 shrink-0" />
              <span className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                備份碼 (Backup Codes)
              </span>
            </div>
            <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300 leading-relaxed mb-3">
              每個備份碼只能使用一次。當你無法使用 Authenticator App 時可用它登入。
              <span className="font-bold">請立即妥善保存</span>，關閉視窗後無法再查看。
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {backupCodes.map((code) => (
                <code
                  key={code}
                  className="px-3 py-2 bg-white dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800 rounded-lg font-mono text-sm text-center text-emerald-900 dark:text-emerald-100"
                >
                  {code}
                </code>
              ))}
            </div>
            <button
              onClick={handleCopyBackupCodes}
              className="mt-3 flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold transition"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? '已複製' : '複製全部備份碼'}
            </button>
          </div>
          <button
            onClick={() => setBackupCodes(null)}
            className="text-xs text-slate-500 hover:text-sky-600 transition font-medium"
          >
            我已保存備份碼，完成
          </button>
        </div>
      ) : !status ? (
        /* 未啟用 */
        setup ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Smartphone className="w-4 h-4 text-blue-600" />
                掃描 QR Code 加入 Authenticator App
              </h4>
              <button
                onClick={cancelSetup}
                className="text-xs text-slate-500 hover:text-sky-600 transition font-medium"
              >
                取消
              </button>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-5">
              {/* QR Code */}
              <div className="shrink-0 p-3 bg-white rounded-xl border border-slate-200 shadow-sm">
                <QRCodeSVG value={setup.otpauthUrl} size={180} level="M" marginSize={1} />
              </div>

              {/* 手動輸入 secret */}
              <div className="flex-1 w-full min-w-0 space-y-2">
                <div className="text-[11px] text-slate-500 leading-relaxed">
                  無法掃描？手動輸入以下密鑰到你的 Authenticator App：
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 break-all px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-[11px] text-slate-700 dark:text-slate-200">
                    {showSecret ? setup.secret : '••••••••••••••••'}
                  </code>
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="p-2 text-slate-400 hover:text-slate-600 rounded-lg transition"
                    title={showSecret ? '隱藏密鑰' : '顯示密鑰'}
                  >
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="text-[11px] text-slate-400">
                  帳戶：{setup.account}（{setup.issuer}）
                </div>
              </div>
            </div>

            {/* 驗證啟用 */}
            <form onSubmit={handleEnable} className="pt-1">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                輸入 App 顯示嘅 6 位數驗證碼以確認
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder="••••••"
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.4em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 shrink-0"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  啟用兩步驟驗證
                </button>
              </div>
            </form>
          </div>
        ) : (
          /* 未啟用，顯示啟用按鈕 + 舊 2FA 手動輸入 */
          <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
            <div className="flex items-start gap-2.5 min-w-0">
              <ShieldOff className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-slate-900 dark:text-white">
                  兩步驟驗證未啟用
                </div>
                <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">
                  啟用後，每次登入除咗密碼仲需要 Authenticator App 嘅驗證碼，大幅提升帳號安全性。
                </div>
                <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
                  <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600" />
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">沿用舊 2FA（手動輸入 MYOLD2FA secret）</span>
                </label>
                {useCustom && (
                  <div className="mt-2">
                    <input
                      type="text"
                      value={customSecret}
                      onChange={(e) => setCustomSecret(e.target.value.toUpperCase())}
                      placeholder="MYOLD2FA...（A-Z2-7，至少16字元）"
                      className="w-full px-3 py-2 text-xs font-mono tracking-widest bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="text-[10px] text-slate-400 mt-1">需為有效 base32，提交後仍需用 App 嘅 6 位碼驗證先會寫入 DB。</div>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={handleSetup}
              disabled={loading}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 shrink-0 w-full"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
              {useCustom ? '使用舊 secret 產生 QR' : '啟用兩步驟驗證'}
            </button>
          </div>
        )
      ) : (
        /* 已啟用 */
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-emerald-50/70 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800/60">
            <div className="flex items-start gap-2.5 min-w-0">
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <div className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                  兩步驟驗證已啟用
                </div>
                <div className="text-[11px] text-emerald-800/80 dark:text-emerald-300 leading-relaxed mt-0.5">
                  登入時需輸入 Authenticator App 驗證碼或備份碼。
                </div>
              </div>
            </div>
            <button
              onClick={() => setDisableMode(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg text-xs font-semibold transition border border-red-200 dark:border-red-900/60 shrink-0 w-full sm:w-auto"
            >
              <ShieldOff className="w-3.5 h-3.5" />
              停用兩步驟驗證
            </button>
          </div>

          {/* 停用驗證 form */}
          {disableMode && (
            <form
              onSubmit={handleDisable}
              className="p-4 border border-red-200 dark:border-red-900/60 rounded-xl bg-red-50/40 dark:bg-red-950/30 space-y-3"
            >
              <div className="text-xs text-red-800 dark:text-red-200 font-semibold">
                輸入目前驗證碼以停用兩步驟驗證
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type={showActionCode ? 'text' : 'password'}
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={actionCode}
                  onChange={(e) => setActionCode(e.target.value)}
                  placeholder="6 位數驗證碼"
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.3em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-red-400"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                    確認停用
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDisableMode(false);
                      setActionCode('');
                    }}
                    className="px-3 py-2 text-xs text-slate-500 hover:text-slate-700 rounded-lg transition"
                  >
                    取消
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* 備份碼管理 */}
          {regenerateMode ? (
            <form
              onSubmit={handleRegenerate}
              className="p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50/50 dark:bg-slate-800/60 space-y-3"
            >
              <div className="text-xs text-slate-700 dark:text-slate-200 font-semibold">
                重新生成備份碼需驗證目前驗證碼（舊碼即時作廢）
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={actionCode}
                  onChange={(e) => setActionCode(e.target.value)}
                  placeholder="6 位數驗證碼"
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.3em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
                    確認生成
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRegenerateMode(false);
                      setActionCode('');
                    }}
                    className="px-3 py-2 text-xs text-slate-500 hover:text-slate-700 rounded-lg transition"
                  >
                    取消
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-3 p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
              <div className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200">
                <KeyRound className="w-4 h-4 text-slate-400 shrink-0" />
                <div>
                  <div className="font-semibold">備份碼</div>
                  <div className="text-[11px] text-slate-400">
                    用於無法使用 App 時嘅一次性登入碼（只顯示一次）
                  </div>
                </div>
              </div>
              <button
                onClick={() => setRegenerateMode(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition shrink-0"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                重新生成
              </button>
            </div>
          )}
        </div>
      )}

      <ChangePasswordSection />
    </div>
  );
};
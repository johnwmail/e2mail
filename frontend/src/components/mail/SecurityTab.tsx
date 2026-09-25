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
  Fingerprint,
  Plus,
  Trash2,
  Pencil,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { startRegistration } from '@simplewebauthn/browser';
import { twoFApi, webauthnApi } from '../../api/2fa';
import { authApi } from '../../api/auth';
import { useAuthStore } from '../../stores/useAuthStore';
import { TwoFASetupResponse, WebAuthnCredential } from '../../types/api';
import { useI18n } from '../../i18n';
import { ConfirmDialog } from '../ui/ConfirmDialog';

interface SecurityTabProps {
  sessionEmail?: string;
}

// ChangePasswordSection 經 ldapd 變更登入密碼（僅在伺服器 LDAP_ENABLED 時顯示）。
// 設計見 docs/LDAP.md：後端驗證舊密碼 → 改 ldapd → re-wrap 本地 DEK，當前 session 不會被登出。
// 多帳號時可選目標帳號（類似 Sieve 頁）：選非登入主帳號時只改該帳號嘅 IMAP/SMTP 密碼，唔郁 DEK。
const ChangePasswordSection: React.FC = () => {
  const { t } = useI18n();
  const session = useAuthStore((s) => s.session);
  const accounts = session?.accounts ?? [];
  const loginEmail = (session?.email || '').toLowerCase();
  const isLoginEmail = (email: string) => !!loginEmail && email.toLowerCase() === loginEmail;

  const [enabled, setEnabled] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const selected =
    accounts.find((a) => a.id === accountId) ??
    accounts.find((a) => isLoginEmail(a.email)) ??
    accounts.find((a) => a.isDefault) ??
    accounts[0];
  const isLoginAccount = selected ? isLoginEmail(selected.email) : true;

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
      setMsg({ type: 'error', text: t('security.needLength') });
      return;
    }
    if (newPw !== confirmPw) {
      setMsg({ type: 'error', text: t('security.mismatch') });
      return;
    }
    if (newPw === oldPw) {
      setMsg({ type: 'error', text: t('security.sameAsOld') });
      return;
    }
    setSubmitting(true);
    try {
      await authApi.changePassword(oldPw, newPw, confirmPw, selected?.id);
      setMsg(
        isLoginAccount
          ? { type: 'success', text: t('security.changed') }
          : {
              type: 'success',
              text: t('security.changedAccount', { name: selected?.label || selected?.email || '' }),
            }
      );
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || t('security.changeFailed') });
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
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">
          {isLoginAccount ? t('security.changePassword') : t('security.changePasswordAccount')}
        </h4>
        {accounts.length > 1 && (
          <label className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="text-[11px] text-slate-500">{t('security.accountSelectLabel')}</span>
            <select
              value={selected?.id ?? ''}
              onChange={(e) => {
                setAccountId(e.target.value);
                setMsg(null);
              }}
              className="max-w-[40vw] lg:max-w-none px-2 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label || a.email}
                  {isLoginEmail(a.email) ? t('security.loginAccountSuffix') : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        {isLoginAccount ? t('security.changePasswordHint') : t('security.changePasswordAccountHint')}
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
          <span className="break-words min-w-0">{msg.text}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div>
            <label htmlFor="cp-old" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
              {t('security.oldPassword')}
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
              {t('security.newPassword')}
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
              {t('security.confirmPassword')}
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
            {t('security.change')}
          </button>
          <button
            type="button"
            onClick={() => setShowPw(!showPw)}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition px-1 py-1 min-h-[40px] sm:min-h-0"
          >
            {showPw ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            {showPw ? t('login.hidePassword') : t('login.showPassword')}
          </button>
        </div>
      </form>
    </div>
  );
};

// PasskeysSection 管理 passkey（WebAuthn 第二因素）。文檔見 docs/PASSKEY.md。
const PasskeysSection: React.FC = () => {
  const { t } = useI18n();
  const supported =
    typeof window !== 'undefined' && typeof (window as any).PublicKeyCredential !== 'undefined';

  const [enabled, setEnabled] = useState(false);
  const [creds, setCreds] = useState<WebAuthnCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const status = await twoFApi.getStatus();
      const on = !!status.webauthnEnabled;
      setEnabled(on);
      if (on) {
        const list = await webauthnApi.list();
        setCreds(list.credentials ?? []);
      }
    } catch {
      // 忽略載入錯誤
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!supported || !enabled) return null;

  const handleAdd = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const begin = await webauthnApi.registerBegin();
      const credential = await startRegistration({ optionsJSON: begin.publicKey });
      await webauthnApi.registerFinish(begin.challenge, credential, newName.trim() || undefined);
      setNewName('');
      setMsg({ type: 'success', text: t('security.passkeyAdded') });
      await load();
    } catch (err: any) {
      const cancelled = err?.name === 'NotAllowedError';
      setMsg({
        type: 'error',
        text: cancelled ? t('security.passkeyNotAllowed') : err?.message || t('security.passkeyAddFailed'),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (id: string) => {
    const name = renameVal.trim();
    if (!name) return;
    setBusy(true);
    setMsg(null);
    try {
      await webauthnApi.rename(id, name);
      setRenamingId(null);
      setRenameVal('');
      setMsg({ type: 'success', text: t('security.passkeyRenamed') });
      await load();
    } catch (err: any) {
      setMsg({ type: 'error', text: err?.message || t('security.passkeyRenameFailed') });
    } finally {
      setBusy(false);
    }
  };

  // 真正執行刪除（經 ConfirmDialog 確認後才呼叫）
  const doRemove = async (id: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await webauthnApi.remove(id);
      setDeleteId(null);
      setMsg({ type: 'success', text: t('security.passkeyDeleted') });
      await load();
    } catch (err: any) {
      setMsg({ type: 'error', text: err?.message || t('security.passkeyDeleteFailed') });
    } finally {
      setBusy(false);
    }
  };

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString();
    } catch {
      return '';
    }
  };

  const inputCls =
    'w-full px-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex items-center gap-2">
        <Fingerprint className="w-4 h-4 text-violet-500 shrink-0" />
        <h4 className="text-sm font-bold text-slate-900 dark:text-white">{t('security.passkeysTitle')}</h4>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">{t('security.passkeysHint')}</p>

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
          <span className="break-words min-w-0">{msg.text}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
        </div>
      ) : (
        <>
          {creds.length === 0 ? (
            <div className="text-xs text-slate-400">{t('security.noPasskeys')}</div>
          ) : (
            <ul className="space-y-2">
              {creds.map((c) => (
                <li
                  key={c.id}
                  className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Fingerprint className="w-4 h-4 text-slate-400 shrink-0" />
                    <div className="min-w-0">
                      {renamingId === c.id ? (
                        <input
                          type="text"
                          value={renameVal}
                          autoFocus
                          onChange={(e) => setRenameVal(e.target.value)}
                          className="px-2 py-1 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded outline-none focus:ring-2 focus:ring-blue-500 w-full sm:w-48"
                        />
                      ) : (
                        <div className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                          {c.name || t('security.passkeysTitle')}
                        </div>
                      )}
                      <div className="text-[10px] text-slate-400">
                        {c.lastUsedAt
                          ? t('security.passkeyLastUsed', { date: fmtDate(c.lastUsedAt) })
                          : t('security.passkeyCreated', { date: fmtDate(c.createdAt) })}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {renamingId === c.id ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleRename(c.id)}
                          className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[11px] font-semibold transition disabled:opacity-50"
                        >
                          {t('security.passkeySave')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(null);
                            setRenameVal('');
                          }}
                          className="px-2.5 py-1.5 text-[11px] text-slate-500 hover:text-slate-700 rounded-lg transition"
                        >
                          {t('security.passkeyCancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(c.id);
                            setRenameVal(c.name || '');
                          }}
                          className="flex items-center gap-1 px-2.5 py-1.5 min-h-9 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg text-[11px] font-semibold transition"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          {t('security.passkeyRename')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setDeleteId(c.id)}
                          className="flex items-center gap-1 px-2.5 py-1.5 min-h-9 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg text-[11px] font-semibold transition border border-red-200 dark:border-red-900/60 disabled:opacity-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          {t('security.passkeyDelete')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('security.passkeyNamePlaceholder')}
              className={inputCls}
            />
            <button
              type="button"
              onClick={handleAdd}
              disabled={busy}
              className="flex items-center justify-center gap-1.5 px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 shrink-0"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              {t('security.addPasskey')}
            </button>
          </div>
        </>
      )}

      <ConfirmDialog
        isOpen={deleteId !== null}
        title={t('security.passkeyDelete')}
        message={t('security.passkeyDeleteConfirm', {
          name: creds.find((c) => c.id === deleteId)?.name || t('security.passkeysTitle'),
        })}
        confirmText={t('security.passkeyDelete')}
        danger
        loading={busy}
        onConfirm={() => {
          if (deleteId) doRemove(deleteId);
        }}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
};

export const SecurityTab: React.FC<SecurityTabProps> = ({ sessionEmail }) => {
  const { t } = useI18n();
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
        setMsg({ type: 'error', text: t('security.needOldSecret') });
        setLoading(false);
        return;
      }
      const res = await twoFApi.setup(secretToUse);
      setSetup(res);
      setBackupCodes(null);
      setVerifyCode('');
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || t('security.setupFailed') });
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
      setMsg({ type: 'success', text: t('security.enabled') });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || t('security.codeError') });
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
      setMsg({ type: 'success', text: t('security.disabled') });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || t('security.codeError') });
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
      setMsg({ type: 'success', text: t('security.codesRegen') });
    } catch (err: any) {
      setMsg({ type: 'error', text: err.message || t('security.codeError') });
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
          <span className="break-words min-w-0">{msg.text}</span>
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
                {t('security.backupCodesTitle')}
              </span>
            </div>
            <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300 leading-relaxed mb-3">
              {t('security.backupCodesOnce')}
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
              {copied ? t('common.copied') : t('security.copyCodes')}
            </button>
          </div>
          <button
            onClick={() => setBackupCodes(null)}
            className="text-xs text-slate-500 hover:text-sky-600 transition font-medium"
          >
            {t('security.codesSaved')}
          </button>
        </div>
      ) : !status ? (
        /* 未啟用 */
        setup ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                <Smartphone className="w-4 h-4 text-blue-600" />
                {t('security.scanQr')}
              </h4>
              <button
                onClick={cancelSetup}
                className="text-xs text-slate-500 hover:text-sky-600 transition font-medium"
              >
                {t('common.cancel')}
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
                  {t('security.cannotScan')}
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 break-all px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg font-mono text-[11px] text-slate-700 dark:text-slate-200">
                    {showSecret ? setup.secret : '••••••••••••••••'}
                  </code>
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="p-2 text-slate-400 hover:text-slate-600 rounded-lg transition"
                    title={showSecret ? t('security.hideSecret') : t('security.showSecret')}
                    aria-label={showSecret ? t('security.hideSecret') : t('security.showSecret')}
                  >
                    {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <div className="text-[11px] text-slate-400">
{t('security.accountLabel', { account: setup.account, issuer: setup.issuer })}
                </div>
              </div>
            </div>

            {/* 驗證啟用 */}
            <form onSubmit={handleEnable} className="pt-1">
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                {t('security.enterCodeToEnable')}
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.4em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50 shrink-0"
                >
                  {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  {t('security.enable')}
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
                  {t('security.twoFaOff')}
                </div>
                <div className="text-[11px] text-slate-500 leading-relaxed mt-0.5">
                  {t('security.twoFaOffHint')}
                </div>
                <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
                  <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600" />
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{t('security.reuseOldManual')}</span>
                </label>
                {useCustom && (
                  <div className="mt-2">
                    <input
                      type="text"
                      value={customSecret}
                      onChange={(e) => setCustomSecret(e.target.value.toUpperCase())}
                      placeholder={t('security.customSecretPlaceholder')}
                      className="w-full px-3 py-2 text-xs font-mono tracking-widest bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <div className="text-[10px] text-slate-400 mt-1">{t('security.customSecretHelp')}</div>
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
              {useCustom ? t('security.useOldSecret') : t('security.enable')}
            </button>
          </div>
        )
      ) : (
        /* 已啟用 */
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4 bg-emerald-50/70 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800/60">
            <div className="flex items-start gap-2.5 min-w-0">
              <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-bold text-emerald-900 dark:text-emerald-200">
                  {t('security.twoFaOn')}
                </div>
                <div className="text-[11px] text-emerald-800/80 dark:text-emerald-300 leading-relaxed mt-0.5">
                  {t('security.twoFaOnHint')}
                </div>
              </div>
            </div>
            <button
              onClick={() => setDisableMode(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg text-xs font-semibold transition border border-red-200 dark:border-red-900/60 shrink-0 w-full sm:w-auto"
            >
              <ShieldOff className="w-3.5 h-3.5" />
              {t('security.disable')}
            </button>
          </div>

          {/* 停用驗證 form */}
          {disableMode && (
            <form
              onSubmit={handleDisable}
              className="p-4 border border-red-200 dark:border-red-900/60 rounded-xl bg-red-50/40 dark:bg-red-950/30 space-y-3"
            >
              <div className="text-xs text-red-800 dark:text-red-200 font-semibold">
                {t('security.disableNeedCode')}
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type={showActionCode ? 'text' : 'password'}
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={actionCode}
                  onChange={(e) => setActionCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={t('security.sixDigit')}
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.3em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-red-400"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                    {t('security.confirmDisableBtn')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDisableMode(false);
                      setActionCode('');
                    }}
                    className="px-3 py-2 text-xs text-slate-500 hover:text-slate-700 rounded-lg transition"
                  >
                    {t('common.cancel')}
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
                {t('security.regenNeedCode')}
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  value={actionCode}
                  onChange={(e) => setActionCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={t('security.sixDigit')}
                  className="flex-1 px-3 py-2 text-sm text-center tracking-[0.3em] font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCcw className="w-3.5 h-3.5" />}
                    {t('security.confirmRegenBtn')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRegenerateMode(false);
                      setActionCode('');
                    }}
                    className="px-3 py-2 text-xs text-slate-500 hover:text-slate-700 rounded-lg transition"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            </form>
          ) : (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700">
              <div className="flex items-start sm:items-center gap-2 min-w-0 text-xs text-slate-700 dark:text-slate-200">
                <KeyRound className="w-4 h-4 text-slate-400 shrink-0 mt-0.5 sm:mt-0" />
                <div className="min-w-0">
                  <div className="font-semibold">{t('security.backupCodesTitle')}</div>
                  <div className="text-[11px] text-slate-400 leading-relaxed">
                    {t('security.backupCodesOnceHint')}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setRegenerateMode(true)}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 min-h-10 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition shrink-0 w-full sm:w-auto"
              >
                <RefreshCcw className="w-3.5 h-3.5" />
                {t('security.regenerate')}
              </button>
            </div>
          )}
        </div>
      )}

      <PasskeysSection />

      <ChangePasswordSection />
    </div>
  );
};
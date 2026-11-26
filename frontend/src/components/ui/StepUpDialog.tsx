import React from 'react';
import { AlertTriangle, Lock, X } from 'lucide-react';
import { t, useI18n } from '../../i18n';

interface StepUpDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  loading?: boolean;
  error?: string;
  password: string;
  onPasswordChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * StepUpDialog 要求重新輸入登入密碼，用於刪除 passkey 等敏感操作。
 * 與 ConfirmDialog 一致：手機及桌面都可用，按 Enter 可直接提交。
 */
export const StepUpDialog: React.FC<StepUpDialogProps> = ({
  isOpen,
  title,
  message,
  confirmText = t('common.confirm'),
  danger = false,
  loading = false,
  error,
  password,
  onPasswordChange,
  onConfirm,
  onCancel,
}) => {
  useI18n();
  if (!isOpen) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!loading && password) onConfirm();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="fixed inset-0" onClick={onCancel} />
      <form
        onSubmit={submit}
        className="relative w-full max-w-sm bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 overflow-hidden animate-in zoom-in-95 duration-150"
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                danger ? 'bg-red-100 dark:bg-red-950/50 text-red-600' : 'bg-blue-100 dark:bg-blue-950/50 text-blue-600'
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
            </span>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg transition"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">{message}</p>
          <div>
            <label
              htmlFor="step-up-password"
              className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5"
            >
              {t('security.stepUpPassword')}
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="step-up-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">{t('security.stepUpHint')}</p>
          </div>
          {error && (
            <div className="p-2.5 rounded-lg text-xs bg-red-50 text-red-800 border border-red-200 dark:bg-red-950/40 dark:text-red-200 dark:border-red-900/60">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={loading || !password}
            className={`px-4 py-2 text-xs font-semibold text-white rounded-lg transition disabled:opacity-50 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {loading ? t('common.processing') : confirmText}
          </button>
        </div>
      </form>
    </div>
  );
};

export default StepUpDialog;

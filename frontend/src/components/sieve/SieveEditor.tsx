import React, { useState } from 'react';
import { CheckCircle2, AlertTriangle, Save, Loader2 } from 'lucide-react';
import { sieveApi } from '../../api/sieve';

interface Props {
  accountId: string;
  scriptName: string;
  initialContent: string;
  onSaved: () => void;
}

export const SieveEditor: React.FC<Props> = ({ accountId, scriptName, initialContent, onSaved }) => {
  const [content, setContent] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    setContent(initialContent);
    setCheckResult(null);
    setError(null);
  }, [initialContent, scriptName]);

  const handleCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    setError(null);
    try {
      await sieveApi.check(content, accountId);
      setCheckResult({ ok: true, msg: '語法正確' });
    } catch (e: any) {
      setCheckResult({ ok: false, msg: e.message || '語法錯誤' });
    } finally {
      setChecking(false);
    }
  };

  const handleSave = async (activate: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await sieveApi.put(scriptName, content, accountId);
      if (activate) {
        await sieveApi.activate(scriptName, accountId);
      }
      onSaved();
    } catch (e: any) {
      setError(e.message || '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={handleCheck}
          disabled={checking}
          className="px-3 py-1.5 text-xs font-semibold border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1.5 disabled:opacity-50"
        >
          {checking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
          檢查語法
        </button>
        <button
          onClick={() => handleSave(false)}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center gap-1.5 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          儲存
        </button>
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50"
        >
          儲存並啟用
        </button>
      </div>

      {checkResult && (
        <div className={`px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 ${checkResult.ok ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300' : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'}`}>
          {checkResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {checkResult.msg}
        </div>
      )}
      {error && <div className="px-3 py-2 rounded-lg text-xs bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">{error}</div>}

      <div className="flex-1 flex flex-col min-h-[260px]">
        <label className="text-[11px] font-semibold text-slate-500 mb-1">Sieve 腳本 — {scriptName}</label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full font-mono text-xs leading-5 p-3 bg-slate-900 text-slate-100 rounded-lg border border-slate-700 outline-none focus:ring-2 focus:ring-blue-500 resize-none min-h-[300px]"
          placeholder={'require ["fileinto"];\n# e.g.\nif header :contains "Subject" "spam" {\n  fileinto "Junk";\n  stop;\n}'}
        />
        <div className="text-[10px] text-slate-400 mt-1">支援 Dovecot Pigeonhole：fileinto, reject, redirect, copy, spamtest 等（依伺服器能力）</div>
      </div>
    </div>
  );
};

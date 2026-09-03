import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { SieveRule, SieveCondition, SieveAction, SieveActionType } from '../../types/sieve';
import { rulesToSieve } from '../../utils/sieveGenerator';
import { sieveApi } from '../../api/sieve';
import { mailApi } from '../../api/mail';
import { useI18n } from '../../i18n';

interface Props {
  accountId: string;
  scriptName: string;
  rules: SieveRule[];
  setRules: React.Dispatch<React.SetStateAction<SieveRule[]>>;
  onSaved: () => void;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const selCls =
  'px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500';
const inCls =
  'px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500';

const newCondition = (): SieveCondition => ({
  id: uid(),
  test: 'header',
  part: '',
  op: 'contains',
  negated: false,
  header: 'Subject',
  value: '',
});

const newAction = (): SieveAction => ({ id: uid(), type: 'fileinto', mailbox: 'INBOX' });

const FLAG_OPTIONS = ['\\Seen', '\\Flagged', '\\Answered', '$Junk', '$NotJunk'];

export const RuleBuilder: React.FC<Props> = ({ accountId, scriptName, rules, setRules, onSaved }) => {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fileinto 用：由 IMAP 取得真實資料夾清單（可下拉選亦可自填新名）
  const { data: folders } = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi.getFolders(accountId),
    staleTime: 60000,
    enabled: !!accountId,
  });
  const folderNames = React.useMemo(() => {
    const names = (folders ?? []).map((f) => f.name);
    return Array.from(new Set(names)).sort((a, b) =>
      /^inbox$/i.test(a) ? -1 : /^inbox$/i.test(b) ? 1 : a.localeCompare(b)
    );
  }, [folders]);

  const addRule = () =>
    setRules((prev) => [
      ...prev,
      {
        id: uid(),
        name: t('sieve.ruleN', { n: prev.length + 1 }),
        enabled: true,
        conditionJoin: 'allof',
        conditions: [newCondition()],
        actions: [{ id: uid(), type: 'fileinto', mailbox: 'INBOX' }],
      },
    ]);

  const updateRule = (id: string, patch: Partial<SieveRule>) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRule = (id: string) => setRules((prev) => prev.filter((r) => r.id !== id));

  const addCondition = (ruleId: string) =>
    setRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, conditions: [...r.conditions, newCondition()] } : r)));
  const updateCondition = (ruleId: string, condId: string, patch: Partial<SieveCondition>) =>
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, conditions: r.conditions.map((c) => (c.id === condId ? { ...c, ...patch } : c)) } : r))
    );
  const removeCondition = (ruleId: string, condId: string) =>
    setRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, conditions: r.conditions.filter((c) => c.id !== condId) } : r)));

  const addAction = (ruleId: string) =>
    setRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, actions: [...r.actions, newAction()] } : r)));
  const updateAction = (ruleId: string, actId: string, patch: Partial<SieveAction>) =>
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, actions: r.actions.map((a) => (a.id === actId ? { ...a, ...patch } : a)) } : r))
    );
  const removeAction = (ruleId: string, actId: string) =>
    setRules((prev) => prev.map((r) => (r.id === ruleId ? { ...r, actions: r.actions.filter((a) => a.id !== actId) } : r)));

  const handleSave = async (activate: boolean) => {
    const sieveText = rulesToSieve(rules);
    setSaving(true);
    setError(null);
    try {
      await sieveApi.put(scriptName, sieveText, accountId);
      if (activate) await sieveApi.activate(scriptName, accountId);
      onSaved();
    } catch (e: any) {
      setError(e.message || t('sieve.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const preview = rulesToSieve(rules);

  const needsValue = (c: SieveCondition) => c.test !== 'exists' && c.test !== 'true';
  const needsHeader = (c: SieveCondition) => c.test !== 'true';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={addRule} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> {t('sieve.addRule')}
        </button>
        <button
          onClick={() => handleSave(false)}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} {t('common.save')}
        </button>
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50"
        >
          {t('sieve.saveAndActivate')}
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg text-xs bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300">{error}</div>}

      {rules.length === 0 && (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
          {t('sieve.emptyRules')}
        </div>
      )}

      {rules.map((rule, idx) => (
        <div key={rule.id} className="p-3.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500 shrink-0">#{idx + 1}</span>
            <input
              value={rule.name}
              onChange={(e) => updateRule(rule.id, { name: e.target.value })}
              className="flex-1 min-w-0 px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t('sieve.ruleName')}
            />
            <label className="flex items-center gap-1 shrink-0 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={rule.enabled} onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} className="w-4 h-4" />
              {t('sieve.enabled')}
            </label>
            <button onClick={() => removeRule(rule.id)} className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg" aria-label={t('sieve.deleteRule')}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* 條件 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500">{t('sieve.ifMatch')}</span>
              <select
                value={rule.conditionJoin}
                onChange={(e) => updateRule(rule.id, { conditionJoin: e.target.value as 'allof' | 'anyof' })}
                className={selCls}
              >
                <option value="allof">{t('sieve.allConditions')}</option>
                <option value="anyof">{t('sieve.anyCondition')}</option>
              </select>
              <button onClick={() => addCondition(rule.id)} className="ml-auto px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800">
                {t('sieve.addCondition')}
              </button>
            </div>
            {rule.conditions.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 flex-wrap">
                <select value={c.test} onChange={(e) => updateCondition(rule.id, c.id, { test: e.target.value as SieveCondition['test'] })} className={selCls}>
                  <option value="header">{t('sieve.header')}</option>
                  <option value="address">{t('sieve.address')}</option>
                  <option value="exists">{t('sieve.exists')}</option>
                  <option value="true">{t('sieve.always')}</option>
                </select>
                {c.test === 'address' && (
                  <select value={c.part} onChange={(e) => updateCondition(rule.id, c.id, { part: e.target.value as SieveCondition['part'] })} className={selCls} title={t('sieve.addressPart')}>
                    <option value="">{t('sieve.wholeAddress')}</option>
                    <option value="domain">{t('sieve.domain')}</option>
                    <option value="localpart">{t('sieve.localpart')}</option>
                    <option value="user">{t('sieve.user')}</option>
                  </select>
                )}
                {needsHeader(c) && (
                  <input
                    value={c.header}
                    onChange={(e) => updateCondition(rule.id, c.id, { header: e.target.value })}
                    className={`${inCls} w-32`}
                    placeholder="From,To"
                    title={t('sieve.headerTitle')}
                  />
                )}
                {c.test !== 'exists' && c.test !== 'true' && (
                  <>
                    <select value={c.op} onChange={(e) => updateCondition(rule.id, c.id, { op: e.target.value as SieveCondition['op'] })} className={selCls}>
                      <option value="contains">{t('sieve.contains')}</option>
                      <option value="is">{t('sieve.equals')}</option>
                      <option value="matches">{t('sieve.matches')}</option>
                    </select>
                    <label className="flex items-center gap-1 text-[11px] text-slate-500" title={t('sieve.not')}>
                      <input type="checkbox" checked={c.negated} onChange={(e) => updateCondition(rule.id, c.id, { negated: e.target.checked })} className="w-3.5 h-3.5" />
                      {t('sieve.not')}
                    </label>
                    <input
                      value={c.value}
                      onChange={(e) => updateCondition(rule.id, c.id, { value: e.target.value })}
                      className={`${inCls} flex-1 min-w-[100px]`}
                      placeholder={t('sieve.matchValue')}
                    />
                  </>
                )}
                {c.test === 'exists' && (
                  <label className="flex items-center gap-1 text-[11px] text-slate-500">
                    <input type="checkbox" checked={c.negated} onChange={(e) => updateCondition(rule.id, c.id, { negated: e.target.checked })} className="w-3.5 h-3.5" />
                    {t('sieve.notExists')}
                  </label>
                )}
                <button onClick={() => removeCondition(rule.id, c.id)} className="p-1 text-slate-400 hover:text-red-600" aria-label={t('sieve.deleteCondition')}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* 動作 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500">{t('sieve.then')}</span>
              <button onClick={() => addAction(rule.id)} className="ml-auto px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800">
                {t('sieve.addAction')}
              </button>
            </div>
            {rule.actions.map((a) => {
              const isFlag = a.type === 'setflag' || a.type === 'addflag' || a.type === 'removeflag';
              return (
                <div key={a.id} className="flex items-center gap-1.5 flex-wrap">
                  <select value={a.type} onChange={(e) => updateAction(rule.id, a.id, { type: e.target.value as SieveActionType })} className={selCls}>
                    <option value="fileinto">{t('sieve.fileinto')}</option>
                    <option value="redirect">{t('sieve.redirect')}</option>
                    <option value="reject">{t('sieve.reject')}</option>
                    <option value="discard">{t('sieve.discard')}</option>
                    <option value="keep">{t('sieve.keep')}</option>
                    <option value="setflag">{t('sieve.setflag')}</option>
                    <option value="addflag">{t('sieve.addflag')}</option>
                    <option value="removeflag">{t('sieve.removeflag')}</option>
                    <option value="stop">{t('sieve.stop')}</option>
                  </select>
                  {a.type === 'fileinto' && (
                    <>
                      <input
                        list="sieve-folder-options"
                        value={a.mailbox || ''}
                        onChange={(e) => updateAction(rule.id, a.id, { mailbox: e.target.value })}
                        className={`${inCls} flex-1 min-w-[120px]`}
                        placeholder={t('sieve.folderPlaceholder')}
                      />
                      <label className="flex items-center gap-1 text-[11px] text-slate-500" title={t('sieve.keepCopy')}>
                        <input type="checkbox" checked={!!a.copy} onChange={(e) => updateAction(rule.id, a.id, { copy: e.target.checked })} className="w-3.5 h-3.5" />
                        {t('sieve.copy')}
                      </label>
                    </>
                  )}
                  {a.type === 'redirect' && (
                    <input value={a.address || ''} onChange={(e) => updateAction(rule.id, a.id, { address: e.target.value })} className={`${inCls} flex-1 min-w-[100px]`} placeholder="forward@example.com" />
                  )}
                  {a.type === 'reject' && (
                    <input value={a.text || ''} onChange={(e) => updateAction(rule.id, a.id, { text: e.target.value })} className={`${inCls} flex-1 min-w-[100px]`} placeholder={t('sieve.rejectReason')} />
                  )}
                  {isFlag && (
                    <input
                      list="flags-common"
                      value={a.flag || ''}
                      onChange={(e) => updateAction(rule.id, a.id, { flag: e.target.value })}
                      className={`${inCls} flex-1 min-w-[100px]`}
                      placeholder="\Seen"
                    />
                  )}
                  <button onClick={() => removeAction(rule.id, a.id)} className="p-1 text-slate-400 hover:text-red-600" aria-label={t('sieve.deleteAction')}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* 常用旗標 datalist */}
      <datalist id="flags-common">
        {FLAG_OPTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      {/* fileinto 資料夾 datalist（真實 IMAP 資料夾名） */}
      <datalist id="sieve-folder-options">
        {folderNames.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <details className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
        <summary className="text-xs font-semibold cursor-pointer select-none">{t('sieve.preview')}</summary>
        <pre className="mt-2 p-3 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-700 rounded-lg text-[11px] leading-4 overflow-x-auto whitespace-pre-wrap">{preview}</pre>
      </details>
    </div>
  );
};

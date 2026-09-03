import React, { useState } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { SieveRule, SieveCondition, SieveAction } from '../../types/sieve';
import { rulesToSieve } from '../../utils/sieveGenerator';
import { sieveApi } from '../../api/sieve';

interface Props {
  accountId: string;
  scriptName: string;
  rules: SieveRule[];
  setRules: React.Dispatch<React.SetStateAction<SieveRule[]>>;
  onSaved: () => void;
}

const uid = () => Math.random().toString(36).slice(2, 9);
const headerOptions = ['Subject', 'From', 'To', 'Cc', 'X-Spam-Flag', 'X-Spam-Level', 'List-Id', 'custom'];

export const RuleBuilder: React.FC<Props> = ({ accountId, scriptName, rules, setRules, onSaved }) => {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addRule = () => {
    setRules((prev) => [
      ...prev,
      {
        id: uid(),
        name: `規則 ${prev.length + 1}`,
        enabled: true,
        conditionJoin: 'allof',
        conditions: [{ id: uid(), header: 'Subject', op: 'contains', value: '' }],
        actions: [{ id: uid(), type: 'fileinto', mailbox: 'INBOX' }],
      },
    ]);
  };

  const updateRule = (id: string, patch: Partial<SieveRule>) =>
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRule = (id: string) => setRules((prev) => prev.filter((r) => r.id !== id));

  const addCondition = (ruleId: string) =>
    setRules((prev) =>
      prev.map((r) =>
        r.id === ruleId
          ? { ...r, conditions: [...r.conditions, { id: uid(), header: 'Subject', op: 'contains', value: '' } as SieveCondition] }
          : r
      )
    );

  const updateCondition = (ruleId: string, condId: string, patch: Partial<SieveCondition>) =>
    setRules((prev) =>
      prev.map((r) =>
        r.id === ruleId ? { ...r, conditions: r.conditions.map((c) => (c.id === condId ? { ...c, ...patch } : c)) } : r
      )
    );

  const removeCondition = (ruleId: string, condId: string) =>
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, conditions: r.conditions.filter((c) => c.id !== condId) } : r))
    );

  const addAction = (ruleId: string) =>
    setRules((prev) =>
      prev.map((r) =>
        r.id === ruleId ? { ...r, actions: [...r.actions, { id: uid(), type: 'fileinto', mailbox: 'INBOX' } as SieveAction] } : r
      )
    );

  const updateAction = (ruleId: string, actId: string, patch: Partial<SieveAction>) =>
    setRules((prev) =>
      prev.map((r) =>
        r.id === ruleId ? { ...r, actions: r.actions.map((a) => (a.id === actId ? { ...a, ...patch } : a)) } : r
      )
    );

  const removeAction = (ruleId: string, actId: string) =>
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, actions: r.actions.filter((a) => a.id !== actId) } : r))
    );

  const handleSave = async (activate: boolean) => {
    const sieveText = rulesToSieve(rules);
    setSaving(true);
    setError(null);
    try {
      await sieveApi.put(scriptName, sieveText, accountId);
      if (activate) await sieveApi.activate(scriptName, accountId);
      onSaved();
    } catch (e: any) {
      setError(e.message || '儲存失敗');
    } finally {
      setSaving(false);
    }
  };

  const preview = rulesToSieve(rules);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button onClick={addRule} className="px-3 py-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1.5">
          <Plus className="w-3.5 h-3.5" /> 新增規則
        </button>
        <button
          onClick={() => handleSave(false)}
          disabled={saving}
          className="px-4 py-1.5 text-xs font-semibold border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 disabled:opacity-50 flex items-center gap-1.5"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} 儲存
        </button>
        <button
          onClick={() => handleSave(true)}
          disabled={saving}
          className="px-3 py-1.5 text-xs font-semibold text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
        >
          儲存並啟用
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg text-xs bg-red-50 dark:bg-red-950/30 text-red-700">{error}</div>}

      {rules.length === 0 && (
        <div className="p-8 text-center text-xs text-slate-400 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
          尚未建立規則，點擊「新增規則」開始（例：若 Subject 包含「廣告」則移至 Junk）
        </div>
      )}

      {rules.map((rule, idx) => (
        <div key={rule.id} className="p-3.5 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">#{idx + 1}</span>
            <input
              value={rule.name}
              onChange={(e) => updateRule(rule.id, { name: e.target.value })}
              className="flex-1 px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="規則名稱"
            />
            <label className="flex items-center gap-1 text-xs">
              <input type="checkbox" checked={rule.enabled} onChange={(e) => updateRule(rule.id, { enabled: e.target.checked })} className="w-4 h-4" />
              啟用
            </label>
            <button onClick={() => removeRule(rule.id)} className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* 條件 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500">若符合</span>
              <select
                value={rule.conditionJoin}
                onChange={(e) => updateRule(rule.id, { conditionJoin: e.target.value as 'allof' | 'anyof' })}
                className="px-2 py-1 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
              >
                <option value="allof">全部條件</option>
                <option value="anyof">任一條件</option>
              </select>
              <button onClick={() => addCondition(rule.id)} className="ml-auto px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50">
                + 條件
              </button>
            </div>
            {rule.conditions.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 flex-wrap">
                <select
                  value={headerOptions.includes(c.header) ? c.header : 'custom'}
                  onChange={(e) => updateCondition(rule.id, c.id, { header: e.target.value === 'custom' ? c.header : e.target.value })}
                  className="px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  {headerOptions.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                {(!headerOptions.includes(c.header) || c.header === 'custom') && (
                  <input
                    value={c.header}
                    onChange={(e) => updateCondition(rule.id, c.id, { header: e.target.value })}
                    className="w-24 px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                    placeholder="Header"
                  />
                )}
                <select
                  value={c.op}
                  onChange={(e) => updateCondition(rule.id, c.id, { op: e.target.value as SieveCondition['op'] })}
                  className="px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  <option value="contains">包含</option>
                  <option value="notcontains">不包含</option>
                  <option value="is">等於</option>
                  <option value="notis">不等於</option>
                  <option value="matches">匹配 (wildcard)</option>
                  <option value="exists">存在</option>
                </select>
                {c.op !== 'exists' && (
                  <input
                    value={c.value}
                    onChange={(e) => updateCondition(rule.id, c.id, { value: e.target.value })}
                    className="flex-1 min-w-[100px] px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                    placeholder="值"
                  />
                )}
                <button onClick={() => removeCondition(rule.id, c.id)} className="p-1 text-slate-400 hover:text-red-600">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* 動作 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-slate-500">則執行</span>
              <button onClick={() => addAction(rule.id)} className="ml-auto px-2 py-1 text-[11px] border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50">
                + 動作
              </button>
            </div>
            {rule.actions.map((a) => (
              <div key={a.id} className="flex items-center gap-1.5 flex-wrap">
                <select
                  value={a.type}
                  onChange={(e) => updateAction(rule.id, a.id, { type: e.target.value as SieveAction['type'] })}
                  className="px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                >
                  <option value="fileinto">移至資料夾</option>
                  <option value="redirect">轉寄至</option>
                  <option value="reject">拒絕並回覆</option>
                  <option value="discard">捨棄</option>
                  <option value="keep">保留 (keep)</option>
                  <option value="stop">停止 (stop)</option>
                </select>
                {a.type === 'fileinto' && (
                  <input
                    value={a.mailbox || ''}
                    onChange={(e) => updateAction(rule.id, a.id, { mailbox: e.target.value })}
                    className="flex-1 min-w-[100px] px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                    placeholder="Junk / INBOX.Folder"
                  />
                )}
                {a.type === 'redirect' && (
                  <input
                    value={a.address || ''}
                    onChange={(e) => updateAction(rule.id, a.id, { address: e.target.value })}
                    className="flex-1 min-w-[100px] px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                    placeholder="forward@example.com"
                  />
                )}
                {a.type === 'reject' && (
                  <input
                    value={a.text || ''}
                    onChange={(e) => updateAction(rule.id, a.id, { text: e.target.value })}
                    className="flex-1 min-w-[100px] px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
                    placeholder="拒絕原因"
                  />
                )}
                <button onClick={() => removeAction(rule.id, a.id)} className="p-1 text-slate-400 hover:text-red-600">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 預覽 */}
      <details className="p-3 bg-slate-50 dark:bg-slate-800/50 rounded-lg border border-slate-200 dark:border-slate-700">
        <summary className="text-xs font-semibold cursor-pointer">Sieve 預覽（自動生成）</summary>
        <pre className="mt-2 p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] leading-4 overflow-x-auto whitespace-pre-wrap">{preview}</pre>
      </details>
    </div>
  );
};

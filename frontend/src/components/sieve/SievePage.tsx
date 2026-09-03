import React, { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileCode, Plus, Trash2, CheckCircle2, Loader2, AlertTriangle, Settings2, RefreshCw } from 'lucide-react';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { useAuthStore } from '../../stores/useAuthStore';
import { sieveApi } from '../../api/sieve';
import { SieveEditor } from './SieveEditor';
import { RuleBuilder } from './RuleBuilder';
import { SieveRule } from '../../types/sieve';
import { rulesToSieve, sieveToRules } from '../../utils/sieveGenerator';
import { toast } from '../../stores/useToastStore';
import ConfirmDialog from '../ui/ConfirmDialog';

export const SievePage: React.FC = () => {
  const { setView } = useMailStore();
  const activeAccount = useActiveAccount();
  const accounts = useAuthStore((s) => s.session?.accounts ?? []);
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);
  const queryClient = useQueryClient();

  const accountId = activeAccount?.id || '';
  const [mode, setMode] = useState<'rules' | 'raw'>('rules');
  const [selectedScript, setSelectedScript] = useState<string>('');
  const [newScriptName, setNewScriptName] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [rules, setRules] = useState<SieveRule[]>([]);
  const [rawFallback, setRawFallback] = useState(false);

  const { data: scripts, isLoading, isFetching, error: scriptsError, refetch } = useQuery({
    queryKey: ['sieveScripts', accountId],
    queryFn: () => sieveApi.list(accountId),
    enabled: !!accountId,
    retry: false,
  });

  const { data: capError } = useQuery({
    queryKey: ['sieveCap', accountId],
    queryFn: () => sieveApi.capability(accountId),
    enabled: !!accountId,
    retry: false,
  });

  // 選中腳本自動切換：首次載入選 active 或第一個
  useEffect(() => {
    if (!scripts || scripts.length === 0) {
      setSelectedScript('');
      return;
    }
    if (!selectedScript || !scripts.some((s) => s.name === selectedScript)) {
      const active = scripts.find((s) => s.active);
      setSelectedScript(active ? active.name : scripts[0].name);
    }
  }, [scripts, selectedScript]);

  const { data: scriptContent } = useQuery({
    queryKey: ['sieveScript', accountId, selectedScript],
    queryFn: () => sieveApi.get(selectedScript, accountId),
    enabled: !!accountId && !!selectedScript,
  });

  // 當腳本內容載入，嘗試解析為 rules
  useEffect(() => {
    if (!scriptContent?.content) {
      setRules([]);
      setRawFallback(false);
      return;
    }
    const parsed = sieveToRules(scriptContent.content);
    if (parsed) {
      setRules(parsed);
      setRawFallback(false);
    } else {
      // 非本工具生成，提示切 raw
      setRules([]);
      setRawFallback(true);
      setMode('raw');
    }
  }, [scriptContent]);

  const isUnsupported = !isLoading && scriptsError && capError === undefined;

  const handleCreate = async () => {
    const name = newScriptName.trim();
    if (!name) return;
    const safe = name.endsWith('.sieve') ? name : `${name}.sieve`;
    // 檢查重名
    if (scripts?.some((s) => s.name === safe)) {
      toast('已存在同名腳本');
      return;
    }
    try {
      // 建空腳本
      const init = mode === 'rules' ? rulesToSieve([]) : '# New sieve script\n';
      await sieveApi.put(safe, init, accountId);
      queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
      setSelectedScript(safe);
      setShowNewInput(false);
      setNewScriptName('');
      toast('已建立腳本 ' + safe);
    } catch (e: any) {
      toast('建立失敗: ' + (e.message || e));
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await sieveApi.remove(name, accountId);
      queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
      setDeleteTarget(null);
      toast('已刪除 ' + name);
      if (selectedScript === name) setSelectedScript('');
    } catch (e: any) {
      toast('刪除失敗: ' + (e.message || e));
    }
  };

  const handleActivate = async (name: string) => {
    try {
      await sieveApi.activate(name, accountId);
      queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
      toast('已設為活動腳本：' + name);
    } catch (e: any) {
      toast('啟用失敗: ' + (e.message || e));
    }
  };

  const handleRefresh = () => {
    refetch();
    if (selectedScript) queryClient.invalidateQueries({ queryKey: ['sieveScript', accountId, selectedScript] });
  };

  return (
    <main className="flex-1 flex flex-col bg-slate-50 dark:bg-slate-950 h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 md:px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        <button onClick={() => setView('mail')} className="p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <FileCode className="w-4 h-4 text-amber-600" />
          過濾器 (Sieve)
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {accounts.length > 1 && (
            <select
              value={accountId}
              onChange={(e) => setActiveAccountId(e.target.value)}
              className="px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.label || a.email}</option>
              ))}
            </select>
          )}
          <button onClick={handleRefresh} className="p-2 text-slate-400 hover:text-slate-600 rounded-lg" title="重新整理">
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {!accountId ? (
        <div className="flex-1 flex items-center justify-center p-8 text-xs text-slate-400">請先選擇帳號</div>
      ) : scriptsError ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-3 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500" />
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">無法連接 ManageSieve</div>
          <div className="text-xs text-slate-500 max-w-md">
            {(scriptsError as any)?.message || '此帳號暫不支援 Sieve 過濾器。請檢查伺服器是否已開啟 ManageSieve 或 Sieve 主機設定。'}
          </div>
          <button
            onClick={() => setView('accounts')}
            className="mt-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg flex items-center gap-1.5"
          >
            <Settings2 className="w-3.5 h-3.5" /> 前往帳號設定檢查 Sieve
          </button>
        </div>
      ) : (
        <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
          {/* 左側：腳本列表 */}
          <div className="w-full lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden max-h-[40vh] lg:max-h-none">
            <div className="p-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300">腳本</span>
              <span className="text-[11px] text-slate-400">({scripts?.length ?? 0})</span>
              <button
                onClick={() => setShowNewInput((v) => !v)}
                className="ml-auto px-2 py-1 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> 新增
              </button>
            </div>
            {showNewInput && (
              <div className="p-3 flex gap-1.5 border-b border-slate-200 dark:border-slate-800">
                <input
                  value={newScriptName}
                  onChange={(e) => setNewScriptName(e.target.value)}
                  placeholder="myfilter (.sieve)"
                  className="flex-1 px-2 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button onClick={handleCreate} className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg">
                  建立
                </button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="p-8 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> 載入中...
                </div>
              ) : (scripts?.length ?? 0) === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">尚無腳本，點擊「新增」建立第一個過濾器</div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {scripts?.map((s) => (
                    <div
                      key={s.name}
                      onClick={() => setSelectedScript(s.name)}
                      className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer transition ${selectedScript === s.name ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
                    >
                      <FileCode className={`w-4 h-4 shrink-0 ${s.active ? 'text-blue-600' : 'text-slate-400'}`} />
                      <span className={`flex-1 truncate text-xs ${selectedScript === s.name ? 'font-semibold text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-300'}`}>
                        {s.name}
                      </span>
                      {s.active && <span className="px-1.5 py-0.5 text-[9px] font-bold bg-blue-600 text-white rounded">活動</span>}
                      <div className="flex items-center gap-1 shrink-0">
                        {!s.active && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleActivate(s.name); }}
                            className="p-1 text-slate-400 hover:text-emerald-600 rounded"
                            title="設為活動"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(s.name); }}
                          className="p-1 text-slate-400 hover:text-red-600 rounded"
                          title="刪除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右側：編輯區 */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-slate-50 dark:bg-slate-950">
            {!selectedScript ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400">請選擇或建立一個腳本</div>
            ) : !scriptContent ? (
              <div className="flex items-center justify-center p-12 text-xs text-slate-400 gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> 載入腳本...
              </div>
            ) : (
              <>
                {rawFallback && (
                  <div className="mb-3 px-3 py-2 rounded-lg text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> 此腳本含進階語法，僅能在原始碼模式編輯
                  </div>
                )}
                <div className="flex items-center gap-1 p-1 bg-slate-200 dark:bg-slate-800 rounded-lg w-fit mb-4">
                  <button
                    onClick={() => !rawFallback && setMode('rules')}
                    disabled={rawFallback}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-md transition ${mode === 'rules' ? 'bg-white dark:bg-slate-900 shadow text-slate-900 dark:text-white' : 'text-slate-500 disabled:opacity-40'}`}
                  >
                    規則模式
                  </button>
                  <button
                    onClick={() => setMode('raw')}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-md transition ${mode === 'raw' ? 'bg-white dark:bg-slate-900 shadow text-slate-900 dark:text-white' : 'text-slate-500'}`}
                  >
                    原始碼
                  </button>
                </div>

                {mode === 'rules' && !rawFallback ? (
                  <RuleBuilder
                    accountId={accountId}
                    scriptName={selectedScript}
                    rules={rules}
                    setRules={setRules}
                    onSaved={() => {
                      queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
                      queryClient.invalidateQueries({ queryKey: ['sieveScript', accountId, selectedScript] });
                      toast('已保存並重新載入');
                    }}
                  />
                ) : (
                  <SieveEditor
                    accountId={accountId}
                    scriptName={selectedScript}
                    initialContent={scriptContent.content}
                    onSaved={() => {
                      queryClient.invalidateQueries({ queryKey: ['sieveScripts', accountId] });
                      queryClient.invalidateQueries({ queryKey: ['sieveScript', accountId, selectedScript] });
                      toast('已保存');
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="刪除腳本"
        message={`確定要刪除「${deleteTarget}」嗎？此操作無法復原。`}
        confirmText="刪除"
        danger
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </main>
  );
};

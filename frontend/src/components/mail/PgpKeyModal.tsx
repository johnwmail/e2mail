import React, { useState, useEffect, useRef } from 'react';
import {
  Key,
  ShieldCheck,
  Download,
  Copy,
  Plus,
  Trash2,
  Check,
  AlertCircle,
  Loader2,
  Globe,
  Upload,
  UserCheck,
  Cloud,
  CloudUpload,
  CloudDownload,
  ShieldAlert,
} from 'lucide-react';
import { pgpService, PgpKeyPair, PgpContactKey, ParsedKeyInfo, fileToPublicKeyArmor, fileToPrivateKeyArmor } from '../../api/pgp';
import { useAuthStore } from '../../stores/useAuthStore';
import { refreshPgp } from '../../stores/usePgpStore';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useI18n } from '../../i18n';

interface PgpKeyModalProps {
  isOpen?: boolean;
  onClose?: () => void;
  embedded?: boolean;
}

export const PgpKeyModal: React.FC<PgpKeyModalProps> = ({ isOpen = false, onClose, embedded = false }) => {
  const { t } = useI18n();
  const { session } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'mykey' | 'contacts'>('mykey');
  const [keyPair, setKeyPair] = useState<PgpKeyPair | null>(null);
  const [contacts, setContacts] = useState<PgpContactKey[]>([]);
  const [removingEmail, setRemovingEmail] = useState<string | null>(null);
  const [contactToRemove, setContactToRemove] = useState<string | null>(null);
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false);

  // 產生金鑰表單狀態
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  // 匯入個人金鑰狀態
  const [showImportPersonal, setShowImportPersonal] = useState(false);
  const [personalKeyInput, setPersonalKeyInput] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');

  // 聯絡人公鑰匯入與 Keyserver 搜尋
  const [contactEmail, setContactEmail] = useState('');
  const [contactPublicKey, setContactPublicKey] = useState('');
  const [parsedPreviews, setParsedPreviews] = useState<ParsedKeyInfo[]>([]);
  const [isSearchingKeyserver, setIsSearchingKeyserver] = useState(false);

  // 雲端同步狀態
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);

  const [copied, setCopied] = useState(false);
  const [copiedPriv, setCopiedPriv] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const personalFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen || embedded) {
      loadKeys();
      if (session?.email) {
        setName(session.email.split('@')[0]);
      }
    } else {
      // 關閉 modal 時清空上次的狀態
      setMsg(null);
    }
  }, [isOpen, embedded, session]);

  const loadKeys = async () => {
    setKeyPair(await pgpService.ensureKey());
    const list = await pgpService.getContactKeys();
    setContacts(list);
  };

  if (!isOpen && !embedded) return null;

  // 處理公鑰文字輸入與自動解析（支援單把或多把公鑰批次貼上）
  const handlePublicKeyChange = async (text: string) => {
    setContactPublicKey(text);
    if (
      !text.includes('BEGIN PGP PUBLIC KEY BLOCK') &&
      !text.includes('BEGIN PGP PRIVATE KEY BLOCK')
    ) {
      setParsedPreviews([]);
      return;
    }
    try {
      const info = await pgpService.parseKeyInfo(text);
      setParsedPreviews([info]);
      if (info.email && !contactEmail) {
        setContactEmail(info.email);
      }
    } catch {
      try {
        const infos = await pgpService.parseMultipleKeys(text);
        setParsedPreviews(infos);
        if (infos.length === 1 && infos[0].email && !contactEmail) {
          setContactEmail(infos[0].email);
        }
      } catch {
        setParsedPreviews([]);
      }
    }
  };

  // 處理上傳公鑰檔案 (.asc / .pub / .gpg / .key / .txt)，支援多檔與多金鑰批次
  // 為避免前端 openpgp.js 在大檔案（≥4MB 多公鑰）情境下解析失敗，
  // 直接將檔案 armored 內容送到後端，由 ProtonMail/go-crypto 解析。
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    e.target.value = '';

    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    setMsg({ type: 'success', text: t('pgp.uploadingFiles', { count: files.length, bytes: totalBytes.toLocaleString() }) });

    let totalSaved = 0;
    let totalInvalid = 0;
    const allSkipped: string[] = [];
    const failedFiles: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const armored = await fileToPublicKeyArmor(file);
        if (!armored) {
          failedFiles.push(t('pgp.fileEmpty', { name: file.name }));
          continue;
        }
        console.log(`[PGP] ${file.name}: uploading ${armored.length} armored chars to server`);
        const result = await pgpService.importContactKeysFromFile(armored);
        console.log(`[PGP] ${file.name} server result:`, result);
        totalSaved += result.saved;
        totalInvalid += result.invalid;
        allSkipped.push(...result.skipped);
      } catch (err: any) {
        console.error(`[PGP] ${file.name} upload error:`, err);
        failedFiles.push(t('pgp.fileFailed', { name: file.name, error: err?.message || t('pgp.uploadFailed') }));
      }
    }

    const parts: string[] = [];
    if (totalSaved > 0) parts.push(t('pgp.importedKeys', { count: totalSaved }));
    if (allSkipped.length > 0)
      parts.push(t('pgp.skippedDup', { count: allSkipped.length, list: `${allSkipped.slice(0, 5).join(', ')}${allSkipped.length > 5 ? '…' : ''}` }));
    if (totalInvalid > 0)
      parts.push(t('pgp.noEmailCount', { count: totalInvalid }));
    if (failedFiles.length > 0)
      parts.push(t('pgp.filesFailed', { count: failedFiles.length }));

    if (parts.length === 0) {
      parts.push(t('pgp.nothingImported'));
    }

    setMsg({
      type: totalSaved > 0 || allSkipped.length > 0 ? 'success' : 'error',
      text: parts.join('，') + '。',
    });
    setContactPublicKey('');
    setParsedPreviews([]);
    setContactEmail('');
    loadKeys();
  };

  // 處理匯入個人私鑰檔案（支援 .asc armored 與 binary GPG，皆會轉為 ASCII-armored）
  const handlePersonalFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    try {
      const armored = await fileToPrivateKeyArmor(file);
      setPersonalKeyInput(armored);
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.readPrivateFailed', { error: err?.message || String(err) }) });
    }
  };

  // 提交匯入個人私鑰
  const handleImportPersonalKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!personalKeyInput.trim()) return;

    try {
      const imported = await pgpService.importPersonalKey(personalKeyInput, undefined, importPassphrase);
      setKeyPair(imported);
      refreshPgp();
      setShowImportPersonal(false);
      setPersonalKeyInput('');
      setImportPassphrase('');
      setMsg({ type: 'success', text: t('pgp.importedPersonal', { userId: imported.userId }) });
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.importPrivateFailed', { error: err.message }) });
    }
  };

  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session?.email) return;

    setIsGenerating(true);
    setMsg(null);

    try {
      const generated = await pgpService.generateKey(name || 'User', session.email, passphrase);
      setKeyPair(generated);
      refreshPgp();
      setMsg({ type: 'success', text: t('pgp.generated') });
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.generateFailed', { error: err.message }) });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleManualSyncToCloud = async () => {
    if (!keyPair) return;
    setIsCloudSyncing(true);
    setMsg(null);
    try {
      await pgpService.syncKeyringToCloud(keyPair);
      setMsg({ type: 'success', text: t('pgp.backedUp') });
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.backupFailed', { error: err.message }) });
    } finally {
      setIsCloudSyncing(false);
    }
  };

  const handleFetchFromCloud = async () => {
    setIsCloudSyncing(true);
    setMsg(null);
    try {
      const cloudKey = await pgpService.fetchKeyringFromCloud();
      if (cloudKey) {
        setKeyPair(cloudKey);
        refreshPgp();
        setMsg({ type: 'success', text: t('pgp.fetched', { keyId: cloudKey.keyId }) });
      } else {
        setMsg({ type: 'error', text: t('pgp.noCloudKey') });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.fetchFailed', { error: err.message }) });
    } finally {
      setIsCloudSyncing(false);
    }
  };

  const handleCopyPublicKey = () => {
    if (keyPair?.publicKeyArmored) {
      navigator.clipboard.writeText(keyPair.publicKeyArmored);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownloadPublicKey = () => {
    if (!keyPair?.publicKeyArmored) return;
    const blob = new Blob([keyPair.publicKeyArmored], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session?.email || 'publickey'}.public.asc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyPrivateKey = () => {
    if (keyPair?.privateKeyArmored) {
      navigator.clipboard.writeText(keyPair.privateKeyArmored);
      setCopiedPriv(true);
      setTimeout(() => setCopiedPriv(false), 2000);
    }
  };

  const handleDownloadPrivateKey = () => {
    if (!keyPair?.privateKeyArmored) return;
    const blob = new Blob([keyPair.privateKeyArmored], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session?.email || 'privatekey'}.private.asc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSearchKeyserver = async () => {
    if (!contactEmail || !contactEmail.includes('@')) {
      setMsg({ type: 'error', text: t('pgp.needValidEmail') });
      return;
    }

    setIsSearchingKeyserver(true);
    setMsg(null);

    try {
      const key = await pgpService.fetchPublicKeyFromKeyserver(contactEmail);
      if (key) {
        handlePublicKeyChange(key);
        setMsg({ type: 'success', text: t('pgp.foundOnKeyserver', { email: contactEmail }) });
      } else {
        setMsg({ type: 'error', text: t('pgp.notOnKeyserver', { email: contactEmail }) });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.keyserverFailed', { error: err.message }) });
    } finally {
      setIsSearchingKeyserver(false);
    }
  };

  const handleSaveContactKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactPublicKey) return;

    setMsg({ type: 'success', text: t('pgp.uploadingParse') });

    try {
      const result = await pgpService.importContactKeysFromFile(contactPublicKey);
      const parts: string[] = [];
      if (result.saved > 0) parts.push(t('pgp.importedKeys', { count: result.saved }));
      if (result.skipped.length > 0)
        parts.push(t('pgp.skippedDupShort', { count: result.skipped.length }));
      if (result.invalid > 0) parts.push(t('pgp.noEmailCount', { count: result.invalid }));

      setContactEmail('');
      setContactPublicKey('');
      setParsedPreviews([]);
      loadKeys();
      setMsg({
        type: result.saved > 0 ? 'success' : 'error',
        text: parts.join('，') + '。',
      });
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.invalidFormat', { error: err?.message || String(err) }) });
    }
  };

  const handleRemoveContact = async (email: string) => {
    setRemovingEmail(email);
    try {
      await pgpService.removeContactKey(email);
      await loadKeys();
      setMsg({ type: 'success', text: t('pgp.deletedContact', { email }) });
    } catch (err: any) {
      setMsg({ type: 'error', text: t('pgp.deleteFailed', { error: err?.message || String(err) }) });
    } finally {
      setRemovingEmail(null);
      setContactToRemove(null);
    }
  };

  // 移除現有金鑰對（local + cloud）。注意：刪除後舊加密郵件將無法解密，請先下載/複製備份。
  const handleRemoveKey = async () => {
    setConfirmRemoveKey(false);
    pgpService.clearKey();
    pgpService.deleteKeyringFromCloud().catch(() => {});
    setKeyPair(null);
    refreshPgp();
  };

  return (
    <div className={embedded ? 'h-full min-h-0 flex flex-col' : 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm'}>
      <div className={embedded
        ? 'w-full h-full min-h-0 bg-white dark:bg-slate-900 flex flex-col overflow-hidden'
        : 'w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[90vh] max-h-[90dvh] overflow-hidden animate-in fade-in zoom-in-95 duration-150'
      }>
        {/* Modal 頂部標題 */}
        {!embedded && (
          <div className="flex items-center justify-between shrink-0 px-4 md:px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white font-bold text-sm md:text-base min-w-0">
              <Key className="w-5 h-5 text-blue-600 shrink-0" />
              <span className="truncate">{t('pgp.title')}</span>
            </div>
            <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg shrink-0">
              {t('common.close')}
            </button>
          </div>
        )}

        {/* 分頁選單 */}
        <div className="flex shrink-0 border-b border-slate-200 dark:border-slate-800 md:px-6 px-2 gap-3 md:gap-6 text-xs font-semibold overflow-x-auto overflow-y-hidden">
          <button
            onClick={() => {
              setActiveTab('mykey');
              setMsg(null);
            }}
            className={`py-3 px-1 md:px-0 border-b-2 whitespace-nowrap shrink-0 transition ${
              activeTab === 'mykey'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('pgp.myKey')}
          </button>
          <button
            onClick={() => {
              setActiveTab('contacts');
              setMsg(null);
            }}
            className={`py-3 px-1 md:px-0 border-b-2 whitespace-nowrap shrink-0 transition ${
              activeTab === 'contacts'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {t('pgp.contactKeys', { count: contacts.length })}
          </button>
        </div>

        {/* 提示訊息 */}
        {msg && (
          <div
            className={`mx-4 md:mx-6 mt-4 p-3 rounded-lg text-xs flex items-center gap-2 ${
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
            <span>{msg.text}</span>
          </div>
        )}

        {/* 內容區塊 */}
        <div className="p-4 md:p-6 overflow-y-auto flex-1 space-y-6">
          {activeTab === 'mykey' ? (
            <>
              {keyPair ? (
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50/60 dark:bg-blue-950/40 rounded-xl border border-blue-200 dark:border-blue-800/60 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-blue-600" />
                        <span className="font-bold text-sm text-slate-900 dark:text-white">
                          {t('pgp.configured')}
                        </span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 bg-blue-600 text-white font-bold rounded-full">
                        {t('pgp.ready')}
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1 pt-1">
                      <div>
                        <span className="font-semibold text-slate-400">{t('pgp.identity')}</span> {keyPair.userId}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-400">{t('pgp.keyId')}</span>{' '}
                        <code className="bg-slate-200/60 dark:bg-slate-800 px-1 py-0.5 rounded font-mono">
                          {keyPair.keyId}
                        </code>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-400">{t('pgp.fingerprint')}</span>{' '}
                        <code className="text-[11px] font-mono break-all">{keyPair.fingerprint}</code>
                      </div>
                    </div>
                  </div>

                  {/* 雲端密文同步資訊欄 */}
                  <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                      <Cloud className="w-4 h-4 text-blue-600" />
                      <div>
                        <div className="font-semibold">{t('pgp.cloudTitle')}</div>
                        <div className="text-[11px] text-slate-400">{t('pgp.cloudHint')}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleManualSyncToCloud}
                        disabled={isCloudSyncing}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition disabled:opacity-50 text-[11px]"
                      >
                        {isCloudSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                        {t('pgp.backupNow')}
                      </button>
                    </div>
                  </div>

                  {/* 公鑰匯出與複製 */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                      {t('pgp.publicKeyLabel')}
                    </label>
                    <textarea
                      readOnly
                      value={keyPair.publicKeyArmored}
                      rows={6}
                      className="w-full p-2.5 text-xs font-mono bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none resize-none"
                    />
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <button
                        onClick={handleCopyPublicKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition"
                      >
                        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? t('common.copied') : t('pgp.copyPublic')}
                      </button>
                      <button
                        onClick={handleDownloadPublicKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition border border-slate-200 dark:border-slate-700"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {t('pgp.downloadAsc')}
                      </button>
                      <button
                        onClick={() => setConfirmRemoveKey(true)}
                        className="flex items-center gap-1 px-3 py-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg text-xs font-semibold transition ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {t('pgp.removePair')}
                      </button>
                    </div>
                  </div>

                  {/* 私鑰匯出（已用 PGP passphrase 加密，唔係明文） */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                      {t('pgp.privateKeyLabel')}
                    </label>
                    <div className="flex items-start gap-2 p-2.5 mb-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 rounded-lg">
                      <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed">
                        {t('pgp.privateKeyWarn')}
                      </p>
                    </div>
                    <textarea
                      readOnly
                      value={keyPair.privateKeyArmored}
                      rows={6}
                      className="w-full p-2.5 text-xs font-mono bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none resize-none"
                    />
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <button
                        onClick={handleCopyPrivateKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition border border-slate-200 dark:border-slate-700"
                      >
                        {copiedPriv ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedPriv ? t('common.copied') : t('pgp.copyPrivate')}
                      </button>
                      <button
                        onClick={handleDownloadPrivateKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition border border-slate-200 dark:border-slate-700"
                      >
                        <Download className="w-3.5 h-3.5" />
                        {t('pgp.downloadAsc')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* 生成或匯入金鑰 */
                <div className="space-y-6">
                  {/* 若本地無金鑰，提供一鍵自雲端拉取按鈕 */}
                  <div className="p-4 bg-indigo-50/70 dark:bg-indigo-950/50 rounded-xl border border-indigo-200 dark:border-indigo-800/60 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <CloudDownload className="w-5 h-5 text-indigo-600" />
                      <div>
                        <div className="text-xs font-bold text-indigo-950 dark:text-indigo-200">
                          {t('pgp.otherDevice')}
                        </div>
                        <div className="text-[11px] text-indigo-800/80 dark:text-indigo-300">
                          {t('pgp.otherDeviceHint')}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleFetchFromCloud}
                      disabled={isCloudSyncing}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition shadow-sm disabled:opacity-50"
                    >
                      {isCloudSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudDownload className="w-3.5 h-3.5" />}
                      {t('pgp.syncFromCloud')}
                    </button>
                  </div>

                  {showImportPersonal ? (
                    <form onSubmit={handleImportPersonalKey} className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-slate-50/50 space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          {t('pgp.importExisting')}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setShowImportPersonal(false)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {t('pgp.backToGenerate')}
                        </button>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {t('pgp.pasteOrUpload')}
                          </label>
                          <button
                            type="button"
                            onClick={() => personalFileInputRef.current?.click()}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            {t('pgp.chooseAsc')}
                          </button>
                          <input
                            ref={personalFileInputRef}
                            type="file"
                            accept=".asc,.pub,.gpg,.key,.txt"
                            onChange={handlePersonalFileUpload}
                            className="hidden"
                          />
                        </div>
                        <textarea
                          required
                          value={personalKeyInput}
                          onChange={(e) => setPersonalKeyInput(e.target.value)}
                          placeholder="-----BEGIN PGP PRIVATE KEY BLOCK----- ..."
                          rows={6}
                          className="w-full p-2.5 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                        />
                        <input
                          type="password"
                          value={importPassphrase}
                          onChange={(e) => setImportPassphrase(e.target.value)}
                          placeholder={t('pgp.importPassphrase')}
                          className="w-full px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                        />
                      </div>

                      <button
                        type="submit"
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition"
                      >
                        {t('pgp.confirmImport')}
                      </button>
                    </form>
                  ) : (
                    <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-slate-50/50">
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          {t('pgp.generateTitle')}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setShowImportPersonal(true)}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          {t('pgp.importExistingLink')}
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mb-4">
                        {t('pgp.generateHint')}
                      </p>

                      <form onSubmit={handleGenerateKey} className="space-y-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                            {t('pgp.keyName')}
                          </label>
                          <input
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Your Name"
                            className="w-full px-3 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                            {t('pgp.passphrase')} <span className="text-red-500">*</span>
                          </label>
                          <input
                            type="password"
                            required
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                            placeholder={t('pgp.passphrasePlaceholder')}
                            className="w-full px-3 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                          />
                          <p className="mt-1 text-[10px] text-slate-400 leading-relaxed">
                            {t('pgp.passphraseHelp')}
                          </p>
                        </div>
                        <button
                          type="submit"
                          disabled={isGenerating}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                        >
                          {isGenerating ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              {t('pgp.generating')}
                            </>
                          ) : (
                            <>
                              <Plus className="w-3.5 h-3.5" />
                              {t('pgp.generateNow')}
                            </>
                          )}
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            /* 聯絡人公鑰匯入與管理 */
            <div className="space-y-6">
              <form
                onSubmit={handleSaveContactKey}
                className="p-4 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 space-y-3.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <h4 className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5 min-w-0">
                    <Plus className="w-4 h-4 text-blue-600 shrink-0" />
                    {t('pgp.importContactTitle')}
                  </h4>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold shrink-0 whitespace-nowrap"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {t('pgp.uploadFiles')}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".asc,.pub,.gpg,.key,.txt"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder={t('pgp.contactEmailPlaceholder')}
                    className="flex-1 min-w-0 px-3 py-2 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSearchKeyserver}
                    disabled={isSearchingKeyserver}
                    className="flex items-center justify-center gap-1 px-3 py-2 w-full sm:w-auto bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold transition shrink-0 disabled:opacity-50"
                  >
                    {isSearchingKeyserver ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Globe className="w-3.5 h-3.5 text-indigo-600" />
                    )}
                    {t('pgp.searchKeyserver')}
                  </button>
                </div>

                {/* 公鑰文字區塊 */}
                <div>
                  <textarea
                    required
                    value={contactPublicKey}
                    onChange={(e) => handlePublicKeyChange(e.target.value)}
                    placeholder={t('pgp.pastePublic')}
                    rows={4}
                    className="w-full p-2 text-xs font-mono bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                  />
                </div>

                {/* 自動解析預覽卡片（支援多把公鑰） */}
                {parsedPreviews.length > 0 && (
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 rounded-lg text-xs text-emerald-900 dark:text-emerald-200 space-y-2">
                    <div className="flex items-center gap-1.5 font-bold">
                      <UserCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>
                        {parsedPreviews.length === 1
                          ? t('pgp.parsedOne')
                          : t('pgp.parsedMany', { count: parsedPreviews.length })}
                      </span>
                    </div>
                    {parsedPreviews.map((p, idx) => (
                      <div
                        key={`${p.fingerprint}-${idx}`}
                        className="pl-3 border-l-2 border-emerald-300/60 space-y-0.5"
                      >
                        <div>
                          <span className="font-semibold text-slate-500">{t('pgp.user')}</span>{' '}
                          {p.name || t('common.unnamed')} &lt;{p.email || t('common.unidentified')}&gt;
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">{t('pgp.keyId')}</span>{' '}
                          <code className="font-mono bg-emerald-100 dark:bg-emerald-900/60 px-1 py-0.5 rounded">
                            {p.keyId}
                          </code>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={parsedPreviews.length === 0}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                >
                  {parsedPreviews.length > 1
                    ? t('pgp.importMany', { count: parsedPreviews.length })
                    : t('pgp.importOne')}
                </button>
              </form>

              {/* 已儲存公鑰清單 */}
              <div>
                <h4 className="text-xs font-semibold text-slate-500 mb-2">{t('pgp.storedKeys')}</h4>
                {contacts.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">{t('pgp.noneStored')}</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    {contacts.map((c) => (
                      <div
                        key={c.email}
                        className="p-3 flex items-center justify-between bg-white dark:bg-slate-900"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            <span className="break-all">{c.email}</span>
                            {c.name && <span className="text-slate-400 font-normal">({c.name})</span>}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 mt-0.5 break-all">
                            {c.fingerprint}
                          </div>
                        </div>
                        <button
                          onClick={() => setContactToRemove(c.email)}
                          disabled={removingEmail !== null}
                          className="p-2 shrink-0 text-slate-400 hover:text-red-600 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                          title={removingEmail === c.email ? t('common.deleting') : t('pgp.removeThisKey')}
                          aria-label={removingEmail === c.email ? t('common.deleting') : t('pgp.removeThisKey')}
                        >
                          {removingEmail === c.email ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!contactToRemove}
        title={t('pgp.removeContactTitle')}
        message={t('pgp.removeContactConfirm', { email: contactToRemove ?? '' })}
        confirmText={t('common.delete')}
        danger
        loading={!!removingEmail}
        onConfirm={() => contactToRemove && handleRemoveContact(contactToRemove)}
        onCancel={() => setContactToRemove(null)}
      />

      <ConfirmDialog
        isOpen={confirmRemoveKey}
        title={t('pgp.removePairTitle')}
        message={t('pgp.removePairConfirm')}
        confirmText={t('pgp.remove')}
        danger
        onConfirm={handleRemoveKey}
        onCancel={() => setConfirmRemoveKey(false)}
      />
    </div>
  );
};

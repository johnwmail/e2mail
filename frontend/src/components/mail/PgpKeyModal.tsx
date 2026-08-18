import React, { useState, useEffect, useRef } from 'react';
import {
  X,
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
} from 'lucide-react';
import { pgpService, PgpKeyPair, PgpContactKey, ParsedKeyInfo, fileToPublicKeyArmor, fileToPrivateKeyArmor } from '../../api/pgp';
import { useAuthStore } from '../../stores/useAuthStore';

interface PgpKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PgpKeyModal: React.FC<PgpKeyModalProps> = ({ isOpen, onClose }) => {
  const { session } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'mykey' | 'contacts'>('mykey');
  const [keyPair, setKeyPair] = useState<PgpKeyPair | null>(null);
  const [contacts, setContacts] = useState<PgpContactKey[]>([]);

  // 產生金鑰表單狀態
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  // 匯入個人金鑰狀態
  const [showImportPersonal, setShowImportPersonal] = useState(false);
  const [personalKeyInput, setPersonalKeyInput] = useState('');

  // 聯絡人公鑰匯入與 Keyserver 搜尋
  const [contactEmail, setContactEmail] = useState('');
  const [contactPublicKey, setContactPublicKey] = useState('');
  const [parsedPreviews, setParsedPreviews] = useState<ParsedKeyInfo[]>([]);
  const [isSearchingKeyserver, setIsSearchingKeyserver] = useState(false);

  // 雲端同步狀態
  const [isCloudSyncing, setIsCloudSyncing] = useState(false);

  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const personalFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadKeys();
      if (session?.email) {
        setName(session.email.split('@')[0]);
      }
    } else {
      // 關閉 modal 時清空上次的狀態
      setMsg(null);
    }
  }, [isOpen, session]);

  const loadKeys = async () => {
    setKeyPair(pgpService.getKeyPair());
    const list = await pgpService.getContactKeys();
    setContacts(list);
  };

  if (!isOpen) return null;

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
    const files = e.target.files;
    if (!files || files.length === 0) return;
    e.target.value = '';

    const totalBytes = Array.from(files).reduce((s, f) => s + f.size, 0);
    setMsg({ type: 'success', text: `正在上傳 ${files.length} 個檔案（共 ${totalBytes.toLocaleString()} bytes）至伺服器…` });

    let totalSaved = 0;
    let totalInvalid = 0;
    const allSkipped: string[] = [];
    const failedFiles: string[] = [];

    for (const file of Array.from(files)) {
      try {
        const armored = await fileToPublicKeyArmor(file);
        if (!armored) {
          failedFiles.push(`${file.name} (內容為空)`);
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
        failedFiles.push(`${file.name} (${err?.message || '上傳失敗'})`);
      }
    }

    const parts: string[] = [];
    if (totalSaved > 0) parts.push(`成功匯入 ${totalSaved} 把公鑰`);
    if (allSkipped.length > 0)
      parts.push(`略過 ${allSkipped.length} 把重複 (${allSkipped.slice(0, 5).join(', ')}${allSkipped.length > 5 ? '…' : ''})`);
    if (totalInvalid > 0)
      parts.push(`${totalInvalid} 把無 Email`);
    if (failedFiles.length > 0)
      parts.push(`${failedFiles.length} 個檔案上傳失敗`);

    if (parts.length === 0) {
      parts.push('伺服器未匯入任何公鑰');
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
      setMsg({ type: 'error', text: '讀取私鑰檔案失敗: ' + (err?.message || String(err)) });
    }
  };

  // 提交匯入個人私鑰
  const handleImportPersonalKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!personalKeyInput.trim()) return;

    try {
      const imported = await pgpService.importPersonalKey(personalKeyInput);
      setKeyPair(imported);
      setShowImportPersonal(false);
      setPersonalKeyInput('');
      setMsg({ type: 'success', text: `已成功匯入個人金鑰 (${imported.userId}) 並同步備份至雲端！` });
    } catch (err: any) {
      setMsg({ type: 'error', text: '匯入私鑰失敗，請確認是否包含有效的 PGP PRIVATE KEY 區塊: ' + err.message });
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
      setMsg({ type: 'success', text: 'PGP 金鑰對已成功生成並自動備份加密密文至伺服器！' });
    } catch (err: any) {
      setMsg({ type: 'error', text: '生成金鑰失敗: ' + err.message });
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
      setMsg({ type: 'success', text: '已成功將金鑰包（Passphrase 密文形式）備份至伺服器！換裝置登入將自動載入。' });
    } catch (err: any) {
      setMsg({ type: 'error', text: '雲端備份失敗: ' + err.message });
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
        setMsg({ type: 'success', text: `已成功自伺服器拉取雲端金鑰 (${cloudKey.keyId})！` });
      } else {
        setMsg({ type: 'error', text: '伺服器上尚未備份任何 PGP 金鑰包。' });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: '拉取金鑰失敗: ' + err.message });
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
    a.download = `${session?.email || 'publickey'}.asc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSearchKeyserver = async () => {
    if (!contactEmail || !contactEmail.includes('@')) {
      setMsg({ type: 'error', text: '請先輸入有效的電子郵件地址以進行搜尋' });
      return;
    }

    setIsSearchingKeyserver(true);
    setMsg(null);

    try {
      const key = await pgpService.fetchPublicKeyFromKeyserver(contactEmail);
      if (key) {
        handlePublicKeyChange(key);
        setMsg({ type: 'success', text: `成功自 PGP 金鑰伺服器 (keys.openpgp.org) 找到 ${contactEmail} 的公鑰！` });
      } else {
        setMsg({ type: 'error', text: `在公開金鑰伺服器未找到 ${contactEmail} 的公鑰。請手動上傳檔案或貼上公鑰。` });
      }
    } catch (err: any) {
      setMsg({ type: 'error', text: '查詢金鑰伺服器失敗: ' + err.message });
    } finally {
      setIsSearchingKeyserver(false);
    }
  };

  const handleSaveContactKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!contactPublicKey) return;

    setMsg({ type: 'success', text: '正在上傳至伺服器解析…' });

    try {
      const result = await pgpService.importContactKeysFromFile(contactPublicKey);
      const parts: string[] = [];
      if (result.saved > 0) parts.push(`成功匯入 ${result.saved} 把公鑰`);
      if (result.skipped.length > 0)
        parts.push(`略過 ${result.skipped.length} 把重複`);
      if (result.invalid > 0) parts.push(`${result.invalid} 把無 Email`);

      setContactEmail('');
      setContactPublicKey('');
      setParsedPreviews([]);
      loadKeys();
      setMsg({
        type: result.saved > 0 ? 'success' : 'error',
        text: parts.join('，') + '。',
      });
    } catch (err: any) {
      setMsg({ type: 'error', text: '公鑰格式無效: ' + (err?.message || String(err)) });
    }
  };

  const handleRemoveContact = async (email: string) => {
    await pgpService.removeContactKey(email);
    loadKeys();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal 頂部標題 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <div className="flex items-center gap-2 text-slate-900 dark:text-white font-bold text-base">
            <Key className="w-5 h-5 text-blue-600" />
            <span>PGP / GPG 端到端加密金鑰管理</span>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 分頁選單 */}
        <div className="flex border-b border-slate-200 dark:border-slate-800 px-6 gap-6 text-xs font-semibold">
          <button
            onClick={() => {
              setActiveTab('mykey');
              setMsg(null);
            }}
            className={`py-3 border-b-2 transition ${
              activeTab === 'mykey'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            我的 PGP 金鑰對
          </button>
          <button
            onClick={() => {
              setActiveTab('contacts');
              setMsg(null);
            }}
            className={`py-3 border-b-2 transition ${
              activeTab === 'contacts'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            聯絡人公鑰庫 ({contacts.length})
          </button>
        </div>

        {/* 提示訊息 */}
        {msg && (
          <div
            className={`mx-6 mt-4 p-3 rounded-lg text-xs flex items-center gap-2 ${
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
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {activeTab === 'mykey' ? (
            <>
              {keyPair ? (
                <div className="space-y-4">
                  <div className="p-4 bg-blue-50/60 dark:bg-blue-950/40 rounded-xl border border-blue-200 dark:border-blue-800/60 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-blue-600" />
                        <span className="font-bold text-sm text-slate-900 dark:text-white">
                          已配置 PGP 金鑰對
                        </span>
                      </div>
                      <span className="text-[10px] px-2 py-0.5 bg-blue-600 text-white font-bold rounded-full">
                        已就緒
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1 pt-1">
                      <div>
                        <span className="font-semibold text-slate-400">身份：</span> {keyPair.userId}
                      </div>
                      <div>
                        <span className="font-semibold text-slate-400">Key ID：</span>{' '}
                        <code className="bg-slate-200/60 dark:bg-slate-800 px-1 py-0.5 rounded font-mono">
                          {keyPair.keyId}
                        </code>
                      </div>
                      <div>
                        <span className="font-semibold text-slate-400">指紋：</span>{' '}
                        <code className="text-[11px] font-mono break-all">{keyPair.fingerprint}</code>
                      </div>
                    </div>
                  </div>

                  {/* 雲端密文同步資訊欄 */}
                  <div className="p-3.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300">
                      <Cloud className="w-4 h-4 text-blue-600" />
                      <div>
                        <div className="font-semibold">雲端密文金鑰庫（跨裝置免手動匯入）</div>
                        <div className="text-[11px] text-slate-400">伺服器僅儲存 Passphrase 加密的密文，換手機/新電腦自動同步</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={handleManualSyncToCloud}
                        disabled={isCloudSyncing}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition disabled:opacity-50 text-[11px]"
                      >
                        {isCloudSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudUpload className="w-3.5 h-3.5" />}
                        立即備份
                      </button>
                    </div>
                  </div>

                  {/* 公鑰匯出與複製 */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                      我的公開金鑰 (Public Key) — 可分享給聯絡人加密寄信用
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
                        {copied ? '已複製' : '複製公鑰'}
                      </button>
                      <button
                        onClick={handleDownloadPublicKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold transition border border-slate-200 dark:border-slate-700"
                      >
                        <Download className="w-3.5 h-3.5" />
                        下載 .asc 檔案
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('確定要自瀏覽器與雲端移除此金鑰對嗎？')) {
                            pgpService.saveKeyPair(null);
                            pgpService.deleteKeyringFromCloud().catch(() => {});
                            setKeyPair(null);
                          }
                        }}
                        className="flex items-center gap-1 px-3 py-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg text-xs font-semibold transition ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        移除金鑰對
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
                          已在其他裝置生成過金鑰？
                        </div>
                        <div className="text-[11px] text-indigo-800/80 dark:text-indigo-300">
                          可一鍵自伺服器同步已備份的 PGP 密文金鑰包
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={handleFetchFromCloud}
                      disabled={isCloudSyncing}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold transition shadow-sm disabled:opacity-50"
                    >
                      {isCloudSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudDownload className="w-3.5 h-3.5" />}
                      自雲端同步
                    </button>
                  </div>

                  {showImportPersonal ? (
                    <form onSubmit={handleImportPersonalKey} className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-slate-50/50 space-y-4">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          匯入既有的個人 PGP 金鑰對 (.asc / 私鑰)
                        </h3>
                        <button
                          type="button"
                          onClick={() => setShowImportPersonal(false)}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          返回生成金鑰
                        </button>
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                            貼上私鑰區塊或上傳檔案
                          </label>
                          <button
                            type="button"
                            onClick={() => personalFileInputRef.current?.click()}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            選擇 .asc 檔案
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
                      </div>

                      <button
                        type="submit"
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition"
                      >
                        確認匯入個人金鑰
                      </button>
                    </form>
                  ) : (
                    <div className="border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-slate-50/50">
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          生成全新 PGP 金鑰對
                        </h3>
                        <button
                          type="button"
                          onClick={() => setShowImportPersonal(true)}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                        >
                          <Upload className="w-3.5 h-3.5" />
                          匯入既有私鑰 (.asc)
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mb-4">
                        將在你的瀏覽器中直接使用 ECC Ed25519 演算法生成端對端加密金鑰（私鑰密文會自動備份至伺服器以便跨裝置使用）。
                      </p>

                      <form onSubmit={handleGenerateKey} className="space-y-3">
                        <div>
                          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                            金鑰名稱 (Name)
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
                            保護密碼 (Passphrase, 強烈建議設置)
                          </label>
                          <input
                            type="password"
                            value={passphrase}
                            onChange={(e) => setPassphrase(e.target.value)}
                            placeholder="解密與簽名時需輸入此密碼以保護金鑰"
                            className="w-full px-3 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                          />
                        </div>
                        <button
                          type="submit"
                          disabled={isGenerating}
                          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-semibold transition disabled:opacity-50"
                        >
                          {isGenerating ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              正在生成 Ed25519 金鑰...
                            </>
                          ) : (
                            <>
                              <Plus className="w-3.5 h-3.5" />
                              立即生成並備份金鑰對
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
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-slate-800 dark:text-white flex items-center gap-1.5">
                    <Plus className="w-4 h-4 text-blue-600" />
                    匯入聯絡人 PGP 公開金鑰
                  </h4>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:underline font-semibold"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    上傳 .asc / .pub 檔案
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

                <div className="flex gap-2">
                  <input
                    type="email"
                    value={contactEmail}
                    onChange={(e) => setContactEmail(e.target.value)}
                    placeholder="聯絡人電子郵件 (匯入公鑰後會自動解析填入)"
                    className="flex-1 px-3 py-1.5 text-xs bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSearchKeyserver}
                    disabled={isSearchingKeyserver}
                    className="flex items-center gap-1 px-3 py-1.5 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-semibold transition shrink-0 disabled:opacity-50"
                  >
                    {isSearchingKeyserver ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Globe className="w-3.5 h-3.5 text-indigo-600" />
                    )}
                    從 Keyserver 搜尋
                  </button>
                </div>

                {/* 公鑰文字區塊 */}
                <div>
                  <textarea
                    required
                    value={contactPublicKey}
                    onChange={(e) => handlePublicKeyChange(e.target.value)}
                    placeholder="貼上 -----BEGIN PGP PUBLIC KEY BLOCK----- 區塊，或直接點擊右上角「上傳檔案」..."
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
                          ? '已成功解析公鑰資訊：'
                          : `已偵測到 ${parsedPreviews.length} 把公鑰，按下方按鈕即可批次匯入：`}
                      </span>
                    </div>
                    {parsedPreviews.map((p, idx) => (
                      <div
                        key={`${p.fingerprint}-${idx}`}
                        className="pl-3 border-l-2 border-emerald-300/60 space-y-0.5"
                      >
                        <div>
                          <span className="font-semibold text-slate-500">使用者：</span>{' '}
                          {p.name || '未命名'} &lt;{p.email || '未識別'}&gt;
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">Key ID：</span>{' '}
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
                    ? `確認批次匯入 ${parsedPreviews.length} 把公鑰至本地庫`
                    : '確認儲存公鑰至本地庫'}
                </button>
              </form>

              {/* 已儲存公鑰清單 */}
              <div>
                <h4 className="text-xs font-semibold text-slate-500 mb-2">已儲存的聯絡人公鑰庫</h4>
                {contacts.length === 0 ? (
                  <p className="text-xs text-slate-400 italic">尚未儲存任何聯絡人公鑰。</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
                    {contacts.map((c) => (
                      <div
                        key={c.email}
                        className="p-3 flex items-center justify-between bg-white dark:bg-slate-900"
                      >
                        <div>
                          <div className="text-xs font-bold text-slate-900 dark:text-white flex items-center gap-1.5">
                            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                            <span>{c.email}</span>
                            {c.name && <span className="text-slate-400 font-normal">({c.name})</span>}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400 mt-0.5">
                            {c.fingerprint}
                          </div>
                        </div>
                        <button
                          onClick={() => handleRemoveContact(c.email)}
                          className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg transition"
                          title="刪除此公鑰"
                        >
                          <Trash2 className="w-4 h-4" />
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
    </div>
  );
};

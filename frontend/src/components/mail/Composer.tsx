import React, { useState } from 'react';
import {
  X,
  Minus,
  Maximize2,
  Paperclip,
  Send,
  Loader2,
  Trash2,
  Lock,
  FileSignature,
  Key,
} from 'lucide-react';
import { useMailStore } from '../../stores/useMailStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { mailApi } from '../../api/mail';
import { pgpService } from '../../api/pgp';

export const Composer: React.FC = () => {
  const { isComposerOpen, composerDraft, closeComposer } = useMailStore();
  const { session } = useAuthStore();

  const [to, setTo] = useState(composerDraft?.to?.join(', ') || '');
  const [cc, setCc] = useState(composerDraft?.cc?.join(', ') || '');
  const [bcc, setBcc] = useState(composerDraft?.bcc?.join(', ') || '');
  const [showCc, setShowCc] = useState(!!composerDraft?.cc?.length);
  const [showBcc, setShowBcc] = useState(!!composerDraft?.bcc?.length);
  const [subject, setSubject] = useState(composerDraft?.subject || '');
  const [body, setBody] = useState(composerDraft?.textBody || '');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // PGP 切換開關
  const [enablePgpEncrypt, setEnablePgpEncrypt] = useState(false);
  const [enablePgpSign, setEnablePgpSign] = useState(false);

  // PGP 簽名 Passphrase 彈窗
  const [showSignPassModal, setShowSignPassModal] = useState(false);
  const [signingPassphrase, setSigningPassphrase] = useState('');

  if (!isComposerOpen) return null;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments((prev) => [...prev, ...Array.from(e.target.files!)]);
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!to.trim()) {
      setError('請至少輸入一位收件人');
      return;
    }

    // 若啟用簽名，先檢查私鑰是否需要 Passphrase
    if (enablePgpSign) {
      const myKeyPair = pgpService.getKeyPair();
      if (!myKeyPair) {
        setError('請先在「PGP 金鑰設定」中生成或匯入你的私鑰才能進行數位簽名');
        return;
      }
      const isEncrypted = await pgpService.isPrivateKeyEncrypted(myKeyPair.privateKeyArmored);
      if (isEncrypted && !signingPassphrase) {
        setShowSignPassModal(true);
        return;
      }
    }

    await performSend(signingPassphrase);
  };

  const performSend = async (passphraseToUse?: string) => {
    setIsSending(true);
    setError(null);
    setStatusText(null);

    const toList = to.split(',').map((s) => s.trim()).filter(Boolean);
    const ccList = cc.split(',').map((s) => s.trim()).filter(Boolean);
    const bccList = bcc.split(',').map((s) => s.trim()).filter(Boolean);

    let finalBody = body;
    const isPgpActive = enablePgpEncrypt || enablePgpSign;

    // 處理 PGP 加密與簽名 (支援自動自 keyserver 抓取收件人公鑰)
    if (isPgpActive) {
      const myKeyPair = pgpService.getKeyPair();
      const allContactKeys = await pgpService.getContactKeys();
      const recipientKeys: string[] = [];

      for (const recipient of toList) {
        let foundKey = allContactKeys.find((c) => c.email.toLowerCase() === recipient.toLowerCase())?.publicKeyArmored;

        // 若本地無公鑰，自動從線上 PGP Keyserver 搜尋
        if (!foundKey && enablePgpEncrypt) {
          setStatusText(`正在自 PGP 金鑰伺服器 (keys.openpgp.org) 檢索 ${recipient} 的公鑰...`);
          const onlineKey = await pgpService.fetchPublicKeyFromKeyserver(recipient);
          if (onlineKey) {
            await pgpService.saveContactKey(recipient, onlineKey);
            foundKey = onlineKey;
          }
        }

        if (foundKey) {
          recipientKeys.push(foundKey);
        }
      }

      if (enablePgpEncrypt) {
        if (recipientKeys.length === 0) {
          if (myKeyPair?.publicKeyArmored) {
            recipientKeys.push(myKeyPair.publicKeyArmored);
          } else {
            setError(`未找到收件人 (${toList.join(', ')}) 的 PGP 公開金鑰（已嘗試檢索本地與 keys.openpgp.org）。請確認對方是否已公開金鑰或手動至「PGP 金鑰設定」新增。`);
            setIsSending(false);
            setStatusText(null);
            return;
          }
        }
      }

      setStatusText('正在使用 PGP 金鑰加密信件內文...');
      try {
        finalBody = await pgpService.encrypt({
          text: body,
          recipientPublicKeysArmored: recipientKeys.length > 0 ? recipientKeys : (myKeyPair ? [myKeyPair.publicKeyArmored] : []),
          signerPrivateKeyArmored: enablePgpSign ? myKeyPair?.privateKeyArmored : undefined,
          passphrase: passphraseToUse,
        });
      } catch (pgpErr: any) {
        setError('PGP 加密/簽名失敗: ' + pgpErr.message);
        setIsSending(false);
        setStatusText(null);
        return;
      }
    }

    setStatusText('正在透過 SMTP 發送郵件...');
    try {
      await mailApi.sendMessage({
        from: session?.email,
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject,
        textBody: finalBody,
        // PGP 郵件保持純文字發送，不附加 HTML 標籤以防破壞 ASCII Armor 與 CRC 校驗碼
        htmlBody: isPgpActive ? '' : `<div>${finalBody.replace(/\n/g, '<br/>')}</div>`,
        inReplyTo: composerDraft?.inReplyTo,
        references: composerDraft?.references,
        attachments,
      });

      setShowSignPassModal(false);
      closeComposer();
    } catch (err: any) {
      setError(err.message || '發送郵件失敗，請檢查 SMTP 設定或網路連線');
    } finally {
      setIsSending(false);
      setStatusText(null);
    }
  };

  return (
    <div
      className={`fixed z-50 bg-white dark:bg-slate-900 shadow-2xl border border-slate-300 dark:border-slate-700 flex flex-col transition-all duration-200 overflow-hidden ${
        isMinimized
          ? 'bottom-0 right-4 md:right-8 w-72 md:w-80 h-12 rounded-t-xl'
          : 'inset-0 md:inset-auto md:bottom-0 md:right-8 md:w-[640px] md:h-[580px] w-full h-[100dvh] md:rounded-t-xl safe-top safe-bottom'
      }`}
    >
      {/* 頂部標題列 */}
      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 text-white md:rounded-t-xl select-none shrink-0">
        <span className="text-sm font-semibold truncate">
          {subject ? `寫信：${subject}` : '撰寫新郵件'}
        </span>
        <div className="flex items-center gap-1.5 text-slate-300">
          <button
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            className="hidden md:block p-1 hover:text-white rounded hover:bg-slate-800 transition"
            title={isMinimized ? '展開' : '最小化'}
          >
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={closeComposer}
            className="p-1 hover:text-white rounded hover:bg-slate-800 transition"
            title="關閉"
          >
            <X className="w-5 h-5 md:w-4 md:h-4" />
          </button>
        </div>
      </div>

      {!isMinimized && (
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden p-3.5 md:p-4 min-w-0">
          {error && (
            <div className="mb-3 p-2 text-xs bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg leading-relaxed">
              {error}
            </div>
          )}

          {statusText && (
            <div className="mb-3 p-2 text-xs bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded-lg flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
              <span>{statusText}</span>
            </div>
          )}

          {/* 收件人 */}
          <div className="flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
            <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">收件人：</span>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="flex-1 text-sm outline-none bg-transparent min-w-0"
              autoFocus
            />
            <div className="flex items-center gap-2 text-xs text-slate-400 shrink-0">
              {!showCc && (
                <button
                  type="button"
                  onClick={() => setShowCc(true)}
                  className="hover:text-blue-600 font-medium px-1"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  type="button"
                  onClick={() => setShowBcc(true)}
                  className="hover:text-blue-600 font-medium px-1"
                >
                  Bcc
                </button>
              )}
            </div>
          </div>

          {/* 副本 (Cc) */}
          {showCc && (
            <div className="flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
              <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">副本：</span>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="cc@example.com"
                className="flex-1 text-sm outline-none bg-transparent min-w-0"
              />
            </div>
          )}

          {/* 密件副本 (Bcc) */}
          {showBcc && (
            <div className="flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
              <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">密件副本：</span>
              <input
                type="text"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                placeholder="bcc@example.com"
                className="flex-1 text-sm outline-none bg-transparent min-w-0"
              />
            </div>
          )}

          {/* 主旨 */}
          <div className="flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
            <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">主旨：</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="輸入郵件主旨"
              className="flex-1 text-sm outline-none bg-transparent font-medium min-w-0"
            />
          </div>

          {/* 附件清單 */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 py-2 border-b border-slate-200 dark:border-slate-800 max-h-24 overflow-y-auto">
              {attachments.map((file, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 dark:bg-slate-800 rounded-full text-xs text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                >
                  <Paperclip className="w-3 h-3 text-slate-400 shrink-0" />
                  <span className="max-w-[140px] truncate">{file.name}</span>
                  <span className="text-[10px] text-slate-400">
                    ({(file.size / 1024).toFixed(0)} KB)
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    className="hover:text-red-500 p-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 郵件內文 */}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="請在此輸入郵件內容..."
            className="flex-1 w-full p-2 my-2 text-sm outline-none resize-none bg-transparent leading-relaxed"
          />

          {/* 底部操作欄與 PGP 開關 */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800 shrink-0">
            <div className="flex items-center gap-1.5 md:gap-2">
              <label className="p-2 text-slate-600 hover:text-blue-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800 rounded-lg cursor-pointer transition">
                <Paperclip className="w-5 h-5 md:w-4 md:h-4" />
                <input
                  type="file"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>

              {/* PGP 加密切換按鈕 */}
              <button
                type="button"
                onClick={() => setEnablePgpEncrypt(!enablePgpEncrypt)}
                className={`flex items-center gap-1 px-2 md:px-2.5 py-1.5 rounded-lg text-xs font-semibold transition border ${
                  enablePgpEncrypt
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                }`}
                title="啟用 PGP 端到端加密（自動自本地或 keys.openpgp.org 獲取公鑰）"
              >
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">PGP 加密</span>
              </button>

              {/* PGP 簽名切換按鈕 */}
              <button
                type="button"
                onClick={() => setEnablePgpSign(!enablePgpSign)}
                className={`flex items-center gap-1 px-2 md:px-2.5 py-1.5 rounded-lg text-xs font-semibold transition border ${
                  enablePgpSign
                    ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                    : 'text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:bg-slate-100'
                }`}
                title="啟用 PGP 數位簽名（需私鑰密碼）"
              >
                <FileSignature className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">PGP 簽名</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeComposer}
                className="p-2 text-slate-400 hover:text-red-600 rounded-lg transition"
                title="捨棄草稿"
              >
                <Trash2 className="w-5 h-5 md:w-4 md:h-4" />
              </button>
              <button
                type="submit"
                disabled={isSending}
                className="flex items-center gap-2 px-4 md:px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition shadow-sm disabled:opacity-50"
              >
                {isSending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    發送中...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    發送
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* PGP 簽名 Passphrase 彈窗 */}
      {showSignPassModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm safe-top safe-bottom">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 rounded-xl p-5 shadow-2xl border border-slate-200 dark:border-slate-800 space-y-4">
            <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
              <Key className="w-4 h-4 text-emerald-600" />
              <span>輸入私鑰密碼以附加 PGP 簽名</span>
            </div>

            <p className="text-xs text-slate-500">
              你的 PGP 私鑰受到密碼保護，請輸入 Passphrase 解鎖以完成數位簽名。
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                performSend(signingPassphrase);
              }}
              className="space-y-3"
            >
              <input
                type="password"
                required
                value={signingPassphrase}
                onChange={(e) => setSigningPassphrase(e.target.value)}
                placeholder="輸入你的 PGP 私鑰密碼"
                className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignPassModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 rounded-lg"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSending}
                  className="px-3.5 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold"
                >
                  {isSending ? '發送中...' : '確認簽名並發送'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

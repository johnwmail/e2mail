import React, { useState, useEffect } from 'react';
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
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { mailApi } from '../../api/mail';
import { contactsApi } from '../../api/addressBook';
import { pgpService } from '../../api/pgp';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../i18n';

export const Composer: React.FC = () => {
  const { t } = useI18n();
  const { isComposerOpen, composerDraft, closeComposer } = useMailStore();
  const activeAccount = useActiveAccount();

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

  // 通訊錄自動完成（To/Cc/Bcc 共用）
  const getLastToken = (val: string) => {
    const parts = val.split(',');
    return parts[parts.length - 1].trim();
  };
  const [toSuggestOpen, setToSuggestOpen] = useState(false);
  const [ccSuggestOpen, setCcSuggestOpen] = useState(false);
  const [bccSuggestOpen, setBccSuggestOpen] = useState(false);
  const toLastToken = getLastToken(to);
  const ccLastToken = getLastToken(cc);
  const bccLastToken = getLastToken(bcc);
  const { data: toSuggest } = useQuery({
    queryKey: ['contacts-suggest', toLastToken],
    queryFn: () => contactsApi.list(toLastToken, 8),
    enabled: toSuggestOpen && toLastToken.length >= 1,
    staleTime: 10000,
  });
  const { data: ccSuggest } = useQuery({
    queryKey: ['contacts-suggest', ccLastToken],
    queryFn: () => contactsApi.list(ccLastToken, 8),
    enabled: ccSuggestOpen && ccLastToken.length >= 1,
    staleTime: 10000,
  });
  const { data: bccSuggest } = useQuery({
    queryKey: ['contacts-suggest', bccLastToken],
    queryFn: () => contactsApi.list(bccLastToken, 8),
    enabled: bccSuggestOpen && bccLastToken.length >= 1,
    staleTime: 10000,
  });
  const applySuggest = (field: 'to' | 'cc' | 'bcc', email: string) => {
    const setter = field === 'to' ? setTo : field === 'cc' ? setCc : setBcc;
    const cur = field === 'to' ? to : field === 'cc' ? cc : bcc;
    const parts = cur.split(',');
    parts[parts.length - 1] = ` ${email} `;
    const next = parts.join(',').replace(/^,\s*/, '').replace(/,\s*,/g, ',').trim();
    setter(next + (next.endsWith(',') ? ' ' : ', '));
    if (field === 'to') setToSuggestOpen(false);
    if (field === 'cc') setCcSuggestOpen(false);
    if (field === 'bcc') setBccSuggestOpen(false);
  };

  // composerDraft 改變時（openComposer reply/forward 等）重新 sync 表單 state
  useEffect(() => {
    if (!isComposerOpen || !composerDraft) return;
    const d = composerDraft;
    setTo(d.to?.join(', ') || '');
    setCc(d.cc?.join(', ') || '');
    setBcc(d.bcc?.join(', ') || '');
    setShowCc(!!d.cc?.length);
    setShowBcc(!!d.bcc?.length);
    setSubject(d.subject || '');
    setBody(d.textBody || '');
    setAttachments([]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComposerOpen, composerDraft]);

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
      setError(t('composer.needRecipient'));
      return;
    }

    // 若啟用簽名，先檢查私鑰是否需要 Passphrase
    if (enablePgpSign) {
      const myKeyPair = await pgpService.ensureKey();
      if (!myKeyPair) {
        setError(t('composer.needPrivateKey'));
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
      const myKeyPair = await pgpService.ensureKey();
      const allContactKeys = await pgpService.getContactKeys();
      const recipientKeys: string[] = [];

      for (const recipient of toList) {
        let foundKey = allContactKeys.find((c) => c.email.toLowerCase() === recipient.toLowerCase())?.publicKeyArmored;

        // 若本地無公鑰，自動從線上 PGP Keyserver 搜尋
        if (!foundKey && enablePgpEncrypt) {
          setStatusText(t('composer.fetchingKey', { recipient }));
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
          // 全部收件人都揾唔到公鑰（本地 + keys.openpgp.org 都冇）→ 唔可以 encrypt
          setError(t('composer.missingKeys', { emails: toList.join(', ') }));
          setIsSending(false);
          setStatusText(null);
          return;
        }
        // 部分收件人冇公鑰 → encrypt 會令嗰啲人讀唔到
        if (recipientKeys.length < toList.length) {
          setError(t('composer.someMissingKeys', { count: toList.length - recipientKeys.length }));
          setIsSending(false);
          setStatusText(null);
          return;
        }
      }

      setStatusText(t('composer.encrypting'));
      try {
        finalBody = await pgpService.encrypt({
          text: body,
          recipientPublicKeysArmored: recipientKeys.length > 0 ? recipientKeys : (myKeyPair ? [myKeyPair.publicKeyArmored] : []),
          signerPrivateKeyArmored: enablePgpSign ? myKeyPair?.privateKeyArmored : undefined,
          passphrase: passphraseToUse,
        });
      } catch (pgpErr: any) {
        setError(t('composer.pgpFailed', { error: pgpErr.message }));
        setIsSending(false);
        setStatusText(null);
        return;
      }
    }

    setStatusText(t('composer.sending'));
    try {
      await mailApi.sendMessage({
        from: activeAccount?.email,
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
      }, activeAccount?.id);

      setShowSignPassModal(false);
      closeComposer();
    } catch (err: any) {
      setError(err.message || t('composer.sendFailed'));
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
          {subject ? t('composer.composingSubject', { subject }) : t('composer.newMessage')}
        </span>
        <div className="flex items-center gap-1.5 text-slate-300">
          <button
            type="button"
            onClick={() => setIsMinimized(!isMinimized)}
            className="hidden md:block p-1 hover:text-white rounded hover:bg-slate-800 transition"
            title={isMinimized ? t('composer.expand') : t('composer.minimize')}
          >
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={closeComposer}
            className="p-1 hover:text-white rounded hover:bg-slate-800 transition"
            title={t('composer.close')}
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
          <div className="relative flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
            <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">{t('composer.toLabel')}</span>
            <input
              type="text"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setToSuggestOpen(true);
              }}
              onFocus={() => setToSuggestOpen(true)}
              onBlur={() => setTimeout(() => setToSuggestOpen(false), 150)}
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
            {toSuggestOpen && toSuggest && toSuggest.length > 0 && (
              <div className="absolute left-16 right-0 top-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                {toSuggest.map((c) => (
                  <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => applySuggest('to', c.email)} className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 dark:hover:bg-slate-700 text-left">
                    <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">{(c.displayName || c.email)[0].toUpperCase()}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{c.displayName}</div>
                      <div className="text-[11px] text-slate-500 truncate">{c.email}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 副本 (Cc) */}
          {showCc && (
            <div className="relative flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
              <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">{t('composer.ccLabel')}</span>
              <input
                type="text"
                value={cc}
                onChange={(e) => {
                  setCc(e.target.value);
                  setCcSuggestOpen(true);
                }}
                onFocus={() => setCcSuggestOpen(true)}
                onBlur={() => setTimeout(() => setCcSuggestOpen(false), 150)}
                placeholder="cc@example.com"
                className="flex-1 text-sm outline-none bg-transparent min-w-0"
              />
              {ccSuggestOpen && ccSuggest && ccSuggest.length > 0 && (
                <div className="absolute left-16 right-0 top-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                  {ccSuggest.map((c) => (
                    <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => applySuggest('cc', c.email)} className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 dark:hover:bg-slate-700 text-left">
                      <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">{(c.displayName || c.email)[0].toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{c.displayName}</div>
                        <div className="text-[11px] text-slate-500 truncate">{c.email}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 密件副本 (Bcc) */}
          {showBcc && (
            <div className="relative flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
              <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">{t('composer.bccLabel')}</span>
              <input
                type="text"
                value={bcc}
                onChange={(e) => {
                  setBcc(e.target.value);
                  setBccSuggestOpen(true);
                }}
                onFocus={() => setBccSuggestOpen(true)}
                onBlur={() => setTimeout(() => setBccSuggestOpen(false), 150)}
                placeholder="bcc@example.com"
                className="flex-1 text-sm outline-none bg-transparent min-w-0"
              />
              {bccSuggestOpen && bccSuggest && bccSuggest.length > 0 && (
                <div className="absolute left-16 right-0 top-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                  {bccSuggest.map((c) => (
                    <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => applySuggest('bcc', c.email)} className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-blue-50 dark:hover:bg-slate-700 text-left">
                      <div className="w-6 h-6 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">{(c.displayName || c.email)[0].toUpperCase()}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{c.displayName}</div>
                        <div className="text-[11px] text-slate-500 truncate">{c.email}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 主旨 */}
          <div className="flex items-center border-b border-slate-200 dark:border-slate-800 py-2">
            <span className="text-xs text-slate-500 w-16 shrink-0 font-medium">{t('composer.subjectLabel')}</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t('composer.subjectPlaceholder')}
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
            placeholder={t('composer.bodyPlaceholder')}
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
                title={t('composer.encryptTitle')}
              >
                <Lock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('composer.encrypt')}</span>
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
                title={t('composer.signTitle')}
              >
                <FileSignature className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('composer.sign')}</span>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeComposer}
                className="p-2 text-slate-400 hover:text-red-600 rounded-lg transition"
                title={t('composer.discard')}
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
                    {t('composer.sendingBtn')}
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    {t('composer.send')}
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
              <span>{t('composer.passphraseTitle')}</span>
            </div>

            <p className="text-xs text-slate-500">
              {t('composer.passphraseHint')}
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
                placeholder={t('composer.passphrasePlaceholder')}
                className="w-full px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg outline-none"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSignPassModal(false)}
                  className="px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 rounded-lg"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isSending}
                  className="px-3.5 py-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold"
                >
                  {isSending ? t('composer.sendingBtn') : t('composer.confirmSignSend')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

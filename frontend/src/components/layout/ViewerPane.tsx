import React, { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Reply,
  ReplyAll,
  Forward,
  Trash2,
  Star,
  Mail,
  Paperclip,
  Download,
  MailOpen,
  Calendar,
  ArrowLeft,
  AlertOctagon,
  Code,
  Copy,
  X,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { contactsApi } from '../../api/addressBook';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { EmailFrame } from '../mail/EmailFrame';
import { MessageListResult, MessageSummary } from '../../types/api';
import { UserPlus, Check } from 'lucide-react';
import { useI18n } from '../../i18n';

export const ViewerPane: React.FC = () => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const activeAccount = useActiveAccount();
  const accountId = activeAccount?.id;
  const { currentFolder, selectedUID, selectedFolder, unreadView, setSelectedUID, setSelectedFolder, openComposer, page, limit, searchQuery, listMode } = useMailStore();
  const detailFolder = unreadView && selectedFolder ? selectedFolder : currentFolder;

  const { data: message, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['message', accountId, detailFolder, selectedUID],
    queryFn: () => (selectedUID ? mailApi.getMessageDetail(selectedUID, detailFolder, accountId) : null),
    enabled: !!selectedUID,
    staleTime: 60000,
  });

  // 後端讀取郵件時會自動標記為已讀：直接更新 list cache 中該 mail 嘅 unread flag
  useEffect(() => {
    if (selectedUID != null && message) {
      queryClient.setQueriesData<MessageListResult>(
        { queryKey: ['messages', accountId, detailFolder] },
        (old) => {
          if (!old) return old;
          if (old.mode === 'threads' && old.threads) {
            return {
              ...old,
              threads: old.threads.map((t) => {
                const target = t.messages.find((m) => m.uid === selectedUID);
                if (!target) return t;
                const wasUnread = target.unread;
                return {
                  ...t,
                  messages: t.messages.map((m) =>
                    m.uid === selectedUID ? { ...m, unread: false } : m
                  ),
                  unreadCount:
                    wasUnread && t.unreadCount > 0 ? t.unreadCount - 1 : t.unreadCount,
                };
              }),
            };
          }
          if (!('messages' in old)) return old;
          return {
            ...old,
            messages: old.messages.map((m) =>
              m.uid === selectedUID ? { ...m, unread: false } : m
            ),
          };
        }
      );
      // 未讀彙總列表：立即將已讀郵件移出，返去未讀清單唔再顯示藍點
      queryClient.setQueriesData<MessageListResult>(
        { queryKey: ['unread-aggregate', accountId] },
        (old) => {
          if (!old || !('messages' in old) || !old.messages) return old;
          const before = old.messages.length;
          const filtered = old.messages.filter((m) => {
            if (m.uid !== selectedUID) return true;
            // UID 可能跨 folder 重複，有 folder 就一併比對
            if ((m as any).folder && detailFolder) return (m as any).folder !== detailFolder;
            return false;
          });
          if (filtered.length === before) return old;
          return {
            ...old,
            messages: filtered,
            total: Math.max(0, (old.total ?? before) - (before - filtered.length)),
            totalPages: Math.max(1, Math.ceil(Math.max(0, (old.total ?? before) - (before - filtered.length)) / (old.limit || 50))),
          };
        }
      );
      // 同步 sidebar folders unreadCount（讀咗一封 → 該 folder unread -1）
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
    }
  }, [message, selectedUID, accountId, currentFolder, detailFolder, queryClient]);

  const deleteMutation = useMutation({
    mutationFn: (uid: number) => mailApi.deleteMessages(detailFolder, [uid], false, accountId),
    onSuccess: (_data, uid) => {
      // 自動揀下一封，唔留空
      let nextUID: number | null = null;
      let nextFolder: string | null = null;
      if (unreadView) {
        const agg = queryClient.getQueryData<MessageListResult>(['unread-aggregate', accountId, page, limit]) as MessageListResult | undefined;
        const list = agg?.messages ?? [];
        const idx = list.findIndex((m) => m.uid === uid && (!selectedFolder || (m as any).folder === selectedFolder || !(m as any).folder));
        // fallback: 單靠 uid
        const realIdx = idx !== -1 ? idx : list.findIndex((m) => m.uid === uid);
        if (realIdx !== -1) {
          const cand = list[realIdx + 1] ?? list[realIdx - 1] ?? null;
          if (cand) {
            nextUID = cand.uid;
            nextFolder = (cand as any).folder ?? null;
          }
        }
      } else {
        // 嘗試攞當前資料夾嘅 messages/thread cache（key 必須同 MessageList 完全一致：listMode 係字串）
        const tryKeys: (readonly unknown[])[] = [
          ['messages', accountId, detailFolder, page, limit, searchQuery, listMode],
          // 兼容舊 key（曾用 boolean）避免 cache miss
          ['messages', accountId, detailFolder, page, limit, searchQuery, listMode === 'threads'],
        ];
        let cached: MessageListResult | undefined;
        for (const k of tryKeys) {
          cached = queryClient.getQueryData<MessageListResult>(k as any) as MessageListResult | undefined;
          if (cached) break;
        }
        // 最壞情況：遍歷所有 messages cache 搵對應資料夾嘅最新一頁
        if (!cached) {
          const all = queryClient.getQueriesData<MessageListResult>({ queryKey: ['messages', accountId, detailFolder] });
          for (const [, v] of all) if (v) { cached = v; break; }
        }
        if (cached) {
          if (cached.mode === 'threads' && cached.threads) {
            const tIdx = cached.threads.findIndex((t) => t.messages.some((m) => m.uid === uid));
            if (tIdx !== -1) {
              const curThread = cached.threads[tIdx];
              const remainInThread = curThread ? curThread.messages.filter((m) => m.uid !== uid) : [];
              if (remainInThread.length > 0) {
                // 同一 thread 仲有其他 message，留喺同一 thread（同 MessageList 行為一致）
                const newest = remainInThread.reduce((a: any, b: any) => (new Date(a.date) >= new Date(b.date) ? a : b), remainInThread[0]);
                nextUID = newest.uid;
              } else {
                const candThread = cached.threads[tIdx + 1] ?? cached.threads[tIdx - 1] ?? null;
                if (candThread) {
                  const newest = candThread.messages.reduce((a: any, b: any) => (new Date(a.date) >= new Date(b.date) ? a : b), candThread.messages[0]);
                  nextUID = newest.uid;
                } else {
                  // 搵第一個非空 thread
                  const remainThreads = cached.threads.filter((t) => !t.messages.every((m) => m.uid === uid));
                  const fallback = remainThreads[0];
                  if (fallback) {
                    const newest = fallback.messages.reduce((a: any, b: any) => (new Date(a.date) >= new Date(b.date) ? a : b), fallback.messages[0]);
                    nextUID = newest.uid;
                  }
                }
              }
            }
          } else if (cached.messages) {
            const idx = cached.messages.findIndex((m) => m.uid === uid);
            if (idx !== -1) {
              const cand = cached.messages[idx + 1] ?? cached.messages[idx - 1] ?? null;
              if (cand) nextUID = cand.uid;
              else {
                const remain = cached.messages.filter((m) => m.uid !== uid);
                if (remain[0]) nextUID = remain[0].uid;
              }
            } else {
              // uid 唔喺當前頁（可能已翻頁）→ 直接揀第一封非已刪
              const remain = cached.messages.filter((m) => m.uid !== uid);
              if (remain[0]) nextUID = remain[0].uid;
            }
          }
        }
        // 後備：用 unreadView false 時嘅 detailFolder 唔需要 folder
        nextFolder = null;
      }
      if (nextUID != null) {
        if (unreadView && nextFolder) setSelectedFolder(nextFolder);
        else if (!unreadView) setSelectedFolder(null);
        setSelectedUID(nextUID);
      } else {
        setSelectedUID(null);
      }
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, detailFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  const flagMutation = useMutation({
    mutationFn: ({ flags, op }: { flags: string[]; op: 'add' | 'remove' }) =>
      selectedUID ? mailApi.setFlags(detailFolder, [selectedUID], flags, op, accountId) : Promise.resolve(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message', accountId, detailFolder, selectedUID] });
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, detailFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
    },
  });

  // 垃圾郵件資料夾名 + 移動 mutation
  const { data: folders } = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi.getFolders(accountId),
    enabled: !!accountId,
    staleTime: 60000,
  });
  const junkFolder =
    folders?.find((f) => f.specialUse === 'junk' || f.specialUse === 'spam')?.name ??
    folders?.find((f) => /junk|spam/i.test(f.name))?.name;

  const moveToJunkMutation = useMutation({
    mutationFn: (uid: number) =>
      junkFolder ? mailApi.moveMessages(detailFolder, [uid], junkFolder, accountId) : Promise.resolve(),
    onSuccess: () => {
      setSelectedUID(null);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, detailFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  const handleMoveToJunk = () => {
    if (!junkFolder) return;
    moveToJunkMutation.mutate(message.uid);
  };

  // 通訊錄：解析寄件人是否已在地址簿
  const senderEmail = message?.from?.[0]?.address?.toLowerCase() ?? '';
  const senderName = message?.from?.[0]?.name ?? '';
  const { data: resolvedMap } = useQuery({
    queryKey: ['contact-resolve', senderEmail],
    queryFn: () => (senderEmail ? contactsApi.resolve([senderEmail]) : Promise.resolve({})),
    enabled: !!senderEmail,
    staleTime: 30000,
  });
  const senderContact = senderEmail ? (resolvedMap as any)?.[senderEmail] : null;
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    if (senderContact?.hasAvatar) {
      contactsApi.fetchAvatarBlob(senderContact.id).then((url) => setAvatarUrl(url));
    } else {
      setAvatarUrl(null);
    }
  }, [senderContact]);
  const addContactMutation = useMutation({
    mutationFn: () => contactsApi.fromEmail(senderEmail, senderName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contact-resolve', senderEmail] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
  });

  // PGP 解密後嘅明文（reply/forward 用）；未解密就用原始 body
  const [decryptedContent, setDecryptedContent] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [rawContent, setRawContent] = useState<string | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  // 切換郵件時重置解密內容，避免 reply/forward 用到上一封嘅明文
  useEffect(() => {
    setDecryptedContent(null);
    setRawContent(null);
    setShowRaw(false);
  }, [selectedUID]);
  const replyBodyText = decryptedContent ?? message?.textBody ?? '';

  const handleShowRaw = async () => {
    if (!message) return;
    setShowRaw(true);
    setRawLoading(true);
    try {
      const raw = await mailApi.getRawMessage(message.uid, detailFolder, accountId);
      setRawContent(raw);
    } catch (e: any) {
      setRawContent(t('viewer.loadFailed', { error: e?.message || String(e) }));
    } finally {
      setRawLoading(false);
    }
  };

  if (!selectedUID) {
    return (
      <main className="hidden lg:flex flex-1 bg-slate-50/50 dark:bg-slate-950 flex-col items-center justify-center text-slate-400 p-8 select-none">
        <MailOpen className="w-16 h-16 stroke-1 text-slate-300 dark:text-slate-700 mb-3" />
        <p className="text-sm font-medium">{t('viewer.noSelection')}</p>
      </main>
    );
  }

  if (isError) {
    return (
      <main className="flex-1 bg-white dark:bg-slate-900 p-8 flex flex-col items-center justify-center text-slate-500 gap-3">
        <p className="text-xs text-center">{t('viewer.loadFailed', { error: (error as Error)?.message || String(error) })}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700"
        >
          {t('common.retry')}
        </button>
      </main>
    );
  }

  if (isLoading || !message) {
    return (
      <main className="flex-1 bg-white dark:bg-slate-900 p-8 flex items-center justify-center text-slate-400 text-xs">
        {t('viewer.loading')}
      </main>
    );
  }

  const handleReply = (replyAll = false) => {
    const fromAddr = message.from?.[0]?.address || '';
    const toList = replyAll
      ? [fromAddr, ...(message.to ?? []).map((t) => t.address).filter((a) => a !== fromAddr)]
      : [fromAddr];

    const quoteHeader = t('viewer.replyQuote', { date: message.date, from: fromAddr, subject: message.subject });

    openComposer({
      to: toList,
      cc: replyAll ? (message.cc ?? []).map((c) => c.address) : [],
      subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      textBody: quoteHeader + replyBodyText,
      inReplyTo: message.messageId,
      references: message.messageId,
    });
  };

  const handleForward = () => {
    const fromAddr = message.from?.[0]?.address || '';
    const quoteHeader = t('viewer.forwardQuote', {
      from: fromAddr,
      date: message.date,
      subject: message.subject,
      to: (message.to ?? []).map((recipient) => recipient.address).join(', '),
    });

    openComposer({
      to: [],
      subject: message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      textBody: quoteHeader + replyBodyText,
      references: message.messageId,
    });
  };

  return (
    <main className="flex-1 bg-white dark:bg-slate-900 flex flex-col h-full overflow-hidden w-full min-w-0 max-w-full">
      {/* 頂部操作工具列 (Desktop 顯示) */}
      <div className="hidden lg:flex h-12 border-b border-slate-200 dark:border-slate-800 px-4 items-center justify-between shrink-0 bg-slate-50/50 dark:bg-slate-900/50">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => handleReply(false)}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition"
          >
            <Reply className="w-3.5 h-3.5" />
            {t('viewer.reply')}
          </button>
          <button
            onClick={() => handleReply(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition"
          >
            <ReplyAll className="w-3.5 h-3.5" />
            {t('viewer.replyAll')}
          </button>
          <button
            onClick={handleForward}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition"
          >
            <Forward className="w-3.5 h-3.5" />
            {t('viewer.forward')}
          </button>

          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />

          <button
            onClick={() =>
              flagMutation.mutate({
                flags: ['\\Flagged'],
                op: message.starred ? 'remove' : 'add',
              })
            }
            className="p-1.5 text-slate-500 hover:text-amber-500 rounded-lg transition"
            title={t('viewer.star')}
          >
            <Star
              className={`w-4 h-4 ${
                message.starred ? 'fill-amber-400 text-amber-400' : ''
              }`}
            />
          </button>
          <button
            onClick={() =>
              flagMutation.mutate({
                flags: ['\\Seen'],
                op: 'remove',
              })
            }
            className="p-1.5 text-slate-500 hover:text-blue-600 rounded-lg transition"
            title={t('viewer.markUnread')}
          >
            <Mail className="w-4 h-4" />
          </button>
          {junkFolder && (
            <button
              onClick={handleMoveToJunk}
              disabled={moveToJunkMutation.isPending}
              className="p-1.5 text-slate-500 hover:text-orange-600 rounded-lg transition disabled:opacity-40"
              title={t('viewer.moveToJunk')}
            >
              <AlertOctagon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => deleteMutation.mutate(message.uid)}
            className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg transition"
            title={t('viewer.delete')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
          <button
            onClick={handleShowRaw}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg transition"
            title={t('viewer.showSource')}
          >
            <Code className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 郵件標題與寄件者資訊 */}
      <div className="p-3.5 md:p-6 border-b border-slate-200 dark:border-slate-800 shrink-0 space-y-3 w-full min-w-0">
        {/* 行動端頂部導航條 (包含返回與快速操作按鈕) */}
        <div className="lg:hidden flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800 safe-top">
          <button
            onClick={() => setSelectedUID(null)}
            className="flex items-center gap-1 text-xs font-bold text-blue-600 p-1 -ml-1 hover:opacity-80 transition"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{t('viewer.backToList')}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                flagMutation.mutate({
                  flags: ['\\Flagged'],
                  op: message.starred ? 'remove' : 'add',
                })
              }
              className="p-1.5 text-slate-500 rounded-lg"
              title={t('viewer.star')}
            >
              <Star
                className={`w-4 h-4 ${
                  message.starred ? 'fill-amber-400 text-amber-400' : ''
                }`}
              />
            </button>
            <button
              onClick={() =>
                flagMutation.mutate({
                  flags: ['\\Seen'],
                  op: 'remove',
                })
              }
              className="p-1.5 text-slate-500 rounded-lg"
              title={t('viewer.markUnread')}
            >
              <Mail className="w-4 h-4" />
            </button>
            <button
              onClick={() => deleteMutation.mutate(message.uid)}
              className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg"
              title={t('viewer.delete')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleShowRaw}
              className="p-1.5 text-slate-500 rounded-lg"
              title={t('viewer.showSource')}
            >
              <Code className="w-4 h-4" />
            </button>
          </div>
        </div>

        <h2 className="text-base md:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words">
          {message.subject || t('viewer.noSubject')}
        </h2>

          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {avatarUrl ? (
                <img src={avatarUrl} alt="avatar" className="w-8 h-8 md:w-10 md:h-10 rounded-full object-cover shadow-sm shrink-0" />
              ) : (
                <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-xs md:text-sm shadow-sm shrink-0">
                  {senderContact?.displayName?.[0]?.toUpperCase() ||
                    message.from?.[0]?.name?.[0]?.toUpperCase() ||
                    message.from?.[0]?.address?.[0]?.toUpperCase() ||
                    'U'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                  <span className="font-semibold text-xs md:text-sm text-slate-900 dark:text-white truncate">
                    {senderContact?.displayName || message.from?.[0]?.name || message.from?.[0]?.address}
                  </span>
                  {message.from?.[0]?.name && (
                    <span className="text-[11px] text-slate-400 truncate">
                      &lt;{message.from?.[0]?.address}&gt;
                    </span>
                  )}
                  {senderContact ? (
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded-full border border-emerald-200">
                      <Check className="w-3 h-3" /> {t('viewer.inContacts')}
                    </span>
                  ) : (
                    <button
                      onClick={() => addContactMutation.mutate()}
                      disabled={addContactMutation.isPending}
                      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-full border border-blue-200 transition disabled:opacity-50"
                    >
                      <UserPlus className="w-3 h-3" />
                      {addContactMutation.isPending ? t('viewer.adding') : t('viewer.addContact')}
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {t('viewer.to', { recipients: message.to?.map((recipient) => recipient.name || recipient.address).join(', ') || t('common.none') })}
                </div>
              </div>
            </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0 self-start sm:self-auto">
            <Calendar className="w-3.5 h-3.5" />
            <span>{new Date(message.date).toLocaleString()}</span>
          </div>
        </div>

        {/* 附件下載列 */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex flex-wrap gap-2">
            {message.attachments.map((att) => (
              <a
                key={att.id}
                href={mailApi.getAttachmentUrl(message.uid, att.id, detailFolder)}
                target="_blank"
                rel="noreferrer"
                download={att.filename}
                className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-blue-50 hover:text-blue-600 rounded-lg text-xs font-medium transition border border-slate-200 dark:border-slate-700"
              >
                <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                <span className="max-w-[140px] md:max-w-[200px] truncate">{att.filename}</span>
                <span className="text-[10px] text-slate-400">
                  ({(att.size / 1024).toFixed(0)} KB)
                </span>
                <Download className="w-3.5 h-3.5" />
              </a>
            ))}
          </div>
        )}
      </div>

      {/* 郵件內文沙盒（連 Reading Pane 一齊纵向捲動，單一 scrollbar） */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-2 md:p-6 bg-slate-50/40 dark:bg-slate-950/40 min-w-0">
        <EmailFrame
          uid={message.uid}
          folder={detailFolder}
          htmlBody={message.htmlBody}
          textBody={message.textBody}
          attachments={message.attachments}
          onDecryptedChange={setDecryptedContent}
          trustedSender={!!senderContact}
        />
      </div>

      {/* 行動端底部固定操作欄 (僅在 < lg 螢幕顯示) */}
      <div className="lg:hidden h-14 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 px-4 flex items-center justify-around shrink-0 select-none shadow-lg safe-bottom">
        <button
          onClick={() => handleReply(false)}
          className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300 text-[10px] font-medium"
        >
          <Reply className="w-4 h-4 text-blue-600" />
          {t('viewer.reply')}
        </button>
        <button
          onClick={() => handleReply(true)}
          className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300 text-[10px] font-medium"
        >
          <ReplyAll className="w-4 h-4 text-blue-600" />
          {t('viewer.replyAll')}
        </button>
        <button
          onClick={handleForward}
          className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300 text-[10px] font-medium"
        >
          <Forward className="w-4 h-4 text-blue-600" />
          {t('viewer.forward')}
        </button>
        <button
          onClick={() => deleteMutation.mutate(message.uid)}
          className="flex flex-col items-center gap-1 text-red-600 text-[10px] font-medium"
        >
          <Trash2 className="w-4 h-4" />
          {t('viewer.delete')}
        </button>
      </div>

      {/* Raw Source Modal */}
      {showRaw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-4xl max-h-[85vh] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                <Code className="w-4 h-4" />
                <span>{t('viewer.rawSource')}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (rawContent) navigator.clipboard.writeText(rawContent);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg"
                >
                  <Copy className="w-3.5 h-3.5" />
                  {t('common.copy')}
                </button>
                <button
                  onClick={() => setShowRaw(false)}
                  className="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-50 dark:bg-slate-950">
              {rawLoading ? (
                <div className="text-xs text-slate-500">{t('common.loading')}</div>
              ) : (
                <pre className="text-xs font-mono whitespace-pre-wrap break-all text-slate-800 dark:text-slate-200">{rawContent}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

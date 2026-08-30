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

export const ViewerPane: React.FC = () => {
  const queryClient = useQueryClient();
  const activeAccount = useActiveAccount();
  const accountId = activeAccount?.id;
  const { currentFolder, selectedUID, setSelectedUID, openComposer } = useMailStore();

  const { data: message, isLoading } = useQuery({
    queryKey: ['message', accountId, currentFolder, selectedUID],
    queryFn: () => (selectedUID ? mailApi.getMessageDetail(selectedUID, currentFolder, accountId) : null),
    enabled: !!selectedUID,
    staleTime: 60000,
  });

  // 後端讀取郵件時會自動標記為已讀：直接更新 list cache 中該 mail 嘅 unread flag
  useEffect(() => {
    if (selectedUID != null && message) {
      queryClient.setQueriesData<{ messages: MessageSummary[] } | MessageListResult>(
        { queryKey: ['messages', accountId, currentFolder] },
        (old) => {
          if (!old || !('messages' in old)) return old;
          return {
            ...old,
            messages: old.messages.map((m) =>
              m.uid === selectedUID ? { ...m, unread: false } : m
            ),
          };
        }
      );
      // 同步 sidebar folders unreadCount（讀咗一封 → 該 folder unread -1）
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    }
  }, [message, selectedUID, accountId, currentFolder, queryClient]);

  const deleteMutation = useMutation({
    mutationFn: (uid: number) => mailApi.deleteMessages(currentFolder, [uid], false, accountId),
    onSuccess: () => {
      setSelectedUID(null);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  const flagMutation = useMutation({
    mutationFn: ({ flags, op }: { flags: string[]; op: 'add' | 'remove' }) =>
      selectedUID ? mailApi.setFlags(currentFolder, [selectedUID], flags, op, accountId) : Promise.resolve(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['message', accountId, currentFolder, selectedUID] });
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
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
      junkFolder ? mailApi.moveMessages(currentFolder, [uid], junkFolder, accountId) : Promise.resolve(),
    onSuccess: () => {
      setSelectedUID(null);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
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
      const raw = await mailApi.getRawMessage(message.uid, currentFolder, accountId);
      setRawContent(raw);
    } catch (e: any) {
      setRawContent(`載入失敗: ${e?.message || String(e)}`);
    } finally {
      setRawLoading(false);
    }
  };

  if (!selectedUID) {
    return (
      <main className="hidden lg:flex flex-1 bg-slate-50/50 dark:bg-slate-950 flex-col items-center justify-center text-slate-400 p-8 select-none">
        <MailOpen className="w-16 h-16 stroke-1 text-slate-300 dark:text-slate-700 mb-3" />
        <p className="text-sm font-medium">請在左側清單選擇一封郵件進行檢視</p>
      </main>
    );
  }

  if (isLoading || !message) {
    return (
      <main className="flex-1 bg-white dark:bg-slate-900 p-8 flex items-center justify-center text-slate-400 text-xs">
        正在載入郵件內容與附件...
      </main>
    );
  }

  const handleReply = (replyAll = false) => {
    const fromAddr = message.from?.[0]?.address || '';
    const toList = replyAll
      ? [fromAddr, ...(message.to ?? []).map((t) => t.address).filter((a) => a !== fromAddr)]
      : [fromAddr];

    const quoteHeader = `\n\n--- 原始郵件 (${message.date}) ---\n寄件者: ${fromAddr}\n主旨: ${message.subject}\n\n`;

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
    const quoteHeader = `\n\n---------- 轉寄郵件 ----------\n寄件者: ${fromAddr}\n日期: ${message.date}\n主旨: ${message.subject}\n收件者: ${(message.to ?? []).map((t) => t.address).join(', ')}\n\n`;

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
            回覆
          </button>
          <button
            onClick={() => handleReply(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition"
          >
            <ReplyAll className="w-3.5 h-3.5" />
            全部回覆
          </button>
          <button
            onClick={handleForward}
            className="flex items-center gap-1 px-2.5 py-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-lg text-xs font-medium transition"
          >
            <Forward className="w-3.5 h-3.5" />
            轉寄
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
            title="星標"
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
            title="標為未讀"
          >
            <Mail className="w-4 h-4" />
          </button>
          {junkFolder && (
            <button
              onClick={handleMoveToJunk}
              disabled={moveToJunkMutation.isPending}
              className="p-1.5 text-slate-500 hover:text-orange-600 rounded-lg transition disabled:opacity-40"
              title="移到垃圾郵件"
            >
              <AlertOctagon className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => deleteMutation.mutate(message.uid)}
            className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg transition"
            title="刪除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="h-4 w-px bg-slate-200 dark:bg-slate-700 mx-1" />
          <button
            onClick={handleShowRaw}
            className="p-1.5 text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded-lg transition"
            title="顯示原始碼"
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
            <span>返回清單</span>
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
              title="星標"
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
              title="標為未讀"
            >
              <Mail className="w-4 h-4" />
            </button>
            <button
              onClick={() => deleteMutation.mutate(message.uid)}
              className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg"
              title="刪除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleShowRaw}
              className="p-1.5 text-slate-500 rounded-lg"
              title="顯示原始碼"
            >
              <Code className="w-4 h-4" />
            </button>
          </div>
        </div>

        <h2 className="text-base md:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words">
          {message.subject || '(無主旨)'}
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
                      <Check className="w-3 h-3" /> 已在通訊錄
                    </span>
                  ) : (
                    <button
                      onClick={() => addContactMutation.mutate()}
                      disabled={addContactMutation.isPending}
                      className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-full border border-blue-200 transition disabled:opacity-50"
                    >
                      <UserPlus className="w-3 h-3" />
                      {addContactMutation.isPending ? '加入中...' : '加入聯絡人'}
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  收件人：{message.to?.map((t) => t.name || t.address).join(', ') || '無'}
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
                href={mailApi.getAttachmentUrl(message.uid, att.id, currentFolder)}
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

      {/* 郵件內文沙盒 */}
      <div className="flex-1 p-2 md:p-6 overflow-hidden bg-slate-50/40 dark:bg-slate-950/40 min-w-0">
        <EmailFrame
          uid={message.uid}
          folder={currentFolder}
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
          回覆
        </button>
        <button
          onClick={() => handleReply(true)}
          className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300 text-[10px] font-medium"
        >
          <ReplyAll className="w-4 h-4 text-blue-600" />
          全部回覆
        </button>
        <button
          onClick={handleForward}
          className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300 text-[10px] font-medium"
        >
          <Forward className="w-4 h-4 text-blue-600" />
          轉寄
        </button>
        <button
          onClick={() => deleteMutation.mutate(message.uid)}
          className="flex flex-col items-center gap-1 text-red-600 text-[10px] font-medium"
        >
          <Trash2 className="w-4 h-4" />
          刪除
        </button>
      </div>

      {/* Raw Source Modal */}
      {showRaw && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="w-full max-w-4xl max-h-[85vh] bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-white">
                <Code className="w-4 h-4" />
                <span>郵件原始碼 (Raw Source)</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (rawContent) navigator.clipboard.writeText(rawContent);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg"
                >
                  <Copy className="w-3.5 h-3.5" />
                  複製
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
                <div className="text-xs text-slate-500">載入中...</div>
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

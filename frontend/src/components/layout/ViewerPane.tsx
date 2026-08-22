import React from 'react';
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
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { EmailFrame } from '../mail/EmailFrame';

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
      ? [fromAddr, ...message.to.map((t) => t.address).filter((a) => a !== fromAddr)]
      : [fromAddr];

    const quoteHeader = `\n\n--- 原始郵件 (${message.date}) ---\n寄件者: ${fromAddr}\n主旨: ${message.subject}\n\n`;

    openComposer({
      to: toList,
      cc: replyAll ? message.cc.map((c) => c.address) : [],
      subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      textBody: quoteHeader + (message.textBody || ''),
      inReplyTo: message.messageId,
      references: message.messageId,
    });
  };

  const handleForward = () => {
    const fromAddr = message.from?.[0]?.address || '';
    const quoteHeader = `\n\n---------- 轉寄郵件 ----------\n寄件者: ${fromAddr}\n日期: ${message.date}\n主旨: ${message.subject}\n收件者: ${message.to.map((t) => t.address).join(', ')}\n\n`;

    openComposer({
      to: [],
      subject: message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      textBody: quoteHeader + (message.textBody || ''),
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
          <button
            onClick={() => deleteMutation.mutate(message.uid)}
            className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg transition"
            title="刪除"
          >
            <Trash2 className="w-4 h-4" />
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
          </div>
        </div>

        <h2 className="text-base md:text-xl font-bold text-slate-900 dark:text-white leading-snug break-words">
          {message.subject || '(無主旨)'}
        </h2>

        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-blue-600 text-white font-bold flex items-center justify-center text-xs md:text-sm shadow-sm shrink-0">
              {message.from?.[0]?.name?.[0]?.toUpperCase() ||
                message.from?.[0]?.address?.[0]?.toUpperCase() ||
                'U'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                <span className="font-semibold text-xs md:text-sm text-slate-900 dark:text-white truncate">
                  {message.from?.[0]?.name || message.from?.[0]?.address}
                </span>
                {message.from?.[0]?.name && (
                  <span className="text-[11px] text-slate-400 truncate">
                    &lt;{message.from?.[0]?.address}&gt;
                  </span>
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
    </main>
  );
};

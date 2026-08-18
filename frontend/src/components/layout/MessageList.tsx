import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Star,
  Paperclip,
  Trash2,
  MailCheck,
  Mail,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Inbox,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { useMailStore } from '../../stores/useMailStore';
import { MessageSummary } from '../../types/api';

export const MessageList: React.FC = () => {
  const queryClient = useQueryClient();
  const {
    currentFolder,
    selectedUID,
    setSelectedUID,
    searchQuery,
    page,
    setPage,
    limit,
  } = useMailStore();

  const [selectedUIDs, setSelectedUIDs] = useState<number[]>([]);

  // 取得郵件清單
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['messages', currentFolder, page, limit, searchQuery],
    queryFn: () => mailApi.getMessages(currentFolder, page, limit, searchQuery),
    staleTime: 10000,
  });

  // 修改 Flag Mutation
  const flagMutation = useMutation({
    mutationFn: ({ uids, flags, op }: { uids: number[]; flags: string[]; op: 'add' | 'remove' }) =>
      mailApi.setFlags(currentFolder, uids, flags, op),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });

  // 刪除郵件 Mutation
  const deleteMutation = useMutation({
    mutationFn: (uids: number[]) => mailApi.deleteMessages(currentFolder, uids),
    onSuccess: () => {
      setSelectedUIDs([]);
      if (selectedUID && selectedUIDs.includes(selectedUID)) {
        setSelectedUID(null);
      }
      queryClient.invalidateQueries({ queryKey: ['messages', currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders'] });
    },
  });

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked && data?.messages) {
      setSelectedUIDs(data.messages.map((m) => m.uid));
    } else {
      setSelectedUIDs([]);
    }
  };

  const toggleSelect = (uid: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedUIDs((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid]
    );
  };

  const toggleStar = (msg: MessageSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    const op = msg.starred ? 'remove' : 'add';
    flagMutation.mutate({ uids: [msg.uid], flags: ['\\Flagged'], op });
  };

  const formatDate = (dateStr: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}月${day}日`;
  };

  const messages = data?.messages || [];
  const totalPages = data?.totalPages || 1;

  return (
    <section
      className={`w-full lg:w-[380px] xl:w-[420px] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shrink-0 overflow-hidden min-w-0 max-w-full ${
        selectedUID !== null ? 'hidden lg:flex' : 'flex'
      }`}
    >
      {/* 頂部操作欄 */}
      <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0 bg-slate-50/70 dark:bg-slate-900/70 w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            checked={messages.length > 0 && selectedUIDs.length === messages.length}
            onChange={handleSelectAll}
            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-0 cursor-pointer"
          />

          {selectedUIDs.length > 0 ? (
            <div className="flex items-center gap-1">
              <span className="text-xs font-semibold text-blue-600 mr-1">
                {selectedUIDs.length}
              </span>
              <button
                onClick={() =>
                  flagMutation.mutate({
                    uids: selectedUIDs,
                    flags: ['\\Seen'],
                    op: 'add',
                  })
                }
                className="p-1.5 text-slate-600 hover:text-blue-600 hover:bg-slate-200/60 rounded-lg transition"
                title="標記為已讀"
              >
                <MailCheck className="w-4 h-4" />
              </button>
              <button
                onClick={() =>
                  flagMutation.mutate({
                    uids: selectedUIDs,
                    flags: ['\\Seen'],
                    op: 'remove',
                  })
                }
                className="p-1.5 text-slate-600 hover:text-blue-600 hover:bg-slate-200/60 rounded-lg transition"
                title="標記為未讀"
              >
                <Mail className="w-4 h-4" />
              </button>
              <button
                onClick={() => deleteMutation.mutate(selectedUIDs)}
                className="p-1.5 text-slate-600 hover:text-red-600 hover:bg-slate-200/60 rounded-lg transition"
                title="刪除所選"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <span className="text-xs font-medium text-slate-500 truncate">
              {data?.total ? `共 ${data.total} 封` : '信件清單'}
            </span>
          )}
        </div>

        {/* 分頁與重新整理按鈕 */}
        <div className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
          <span className="text-[11px] font-mono">
            {page} / {totalPages}
          </span>
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg disabled:opacity-20 transition"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
            className="p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg disabled:opacity-20 transition"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={() => refetch()}
            className={`p-1.5 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg ${isFetching ? 'animate-spin' : ''}`}
            title="重新整理"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 郵件清單容器 */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80 w-full min-w-0 overscroll-contain">
        {isLoading ? (
          <div className="p-8 text-center text-xs text-slate-400">正在讀取信件...</div>
        ) : messages.length === 0 ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center">
            <Inbox className="w-12 h-12 stroke-1 mb-2 text-slate-300 dark:text-slate-700" />
            <p className="text-xs">此資料夾沒有郵件</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isSelected = selectedUID === msg.uid;
            const isChecked = selectedUIDs.includes(msg.uid);
            const fromName = msg.from?.[0]?.name || msg.from?.[0]?.address || '未知寄件者';

            return (
              <div
                key={msg.uid}
                onClick={() => setSelectedUID(msg.uid)}
                className={`flex items-start gap-3 px-3.5 py-3 text-xs cursor-pointer transition select-none w-full min-w-0 ${
                  isSelected
                    ? 'bg-blue-50/90 dark:bg-blue-950/50 border-l-4 border-blue-600'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-800/60 active:bg-slate-100 dark:active:bg-slate-800'
                }`}
              >
                {/* 勾選與星標 */}
                <div className="flex flex-col items-center gap-2 pt-0.5 shrink-0">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={(e) => toggleSelect(msg.uid, e)}
                    onChange={() => {}}
                    className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-0 cursor-pointer"
                  />
                  <button
                    onClick={(e) => toggleStar(msg, e)}
                    className="p-0.5 hover:scale-110 transition"
                  >
                    <Star
                      className={`w-4 h-4 ${
                        msg.starred
                          ? 'fill-amber-400 text-amber-400'
                          : 'text-slate-300 hover:text-slate-400'
                      }`}
                    />
                  </button>
                </div>

                {/* 郵件主要摘要 (flex-1 min-w-0 防止水平溢出) */}
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="flex items-center justify-between mb-1 min-w-0">
                    <span
                      className={`truncate text-[13px] md:text-sm ${
                        msg.unread ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'
                      }`}
                    >
                      {fromName}
                    </span>
                    <span className="text-[11px] text-slate-400 shrink-0 ml-2 font-mono">
                      {formatDate(msg.date)}
                    </span>
                  </div>

                  <div
                    className={`truncate text-xs mb-1 ${
                      msg.unread
                        ? 'font-semibold text-slate-800 dark:text-slate-100'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {msg.subject || '(無主旨)'}
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400 min-w-0">
                    <span className="truncate pr-1">{msg.snippet || ''}</span>
                    {msg.hasAttachment && (
                      <Paperclip className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                  </div>
                </div>

                {/* 未讀藍色小圓點 */}
                {msg.unread && (
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-600 mt-1.5 shrink-0 ml-1" />
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};

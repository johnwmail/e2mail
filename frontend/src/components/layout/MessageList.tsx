import React, { useEffect, useRef, useState, useMemo } from 'react';
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
  FolderInput,
  AlertOctagon,
  X,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { contactsApi } from '../../api/addressBook';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { MessageSummary, FolderInfo } from '../../types/api';

const getFolderDisplayName = (folder: FolderInfo) => {
  switch (folder.specialUse) {
    case 'inbox':
      return '收件箱';
    case 'sent':
      return '已發送';
    case 'drafts':
      return '草稿箱';
    case 'trash':
      return '垃圾桶';
    case 'junk':
      return '垃圾郵件';
    case 'archive':
      return '封存';
    default:
      return folder.name;
  }
};

const ContactMiniAvatar: React.FC<{ contact: any }> = ({ contact }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!contact?.hasAvatar) return;
    let alive = true;
    contactsApi.fetchAvatarBlob(contact.id).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [contact?.id, contact?.hasAvatar]);
  if (url) {
    return <img src={url} alt={contact.displayName} className="w-5 h-5 rounded-full object-cover shrink-0" />;
  }
  const initial = (contact.displayName?.[0] || contact.email?.[0] || '?').toUpperCase();
  return (
    <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
      {initial}
    </div>
  );
};

export const MessageList: React.FC = () => {
  const queryClient = useQueryClient();
  const activeAccount = useActiveAccount();
  const accountId = activeAccount?.id;
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
  const [isMultiSelect, setIsMultiSelect] = useState(false);
  const [swipedUID, setSwipedUID] = useState<number | null>(null);
  const [swipeError, setSwipeError] = useState<string | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressIndex = useRef<number>(-1);
  const isMultiSelectRef = useRef(false);
  const pointerDownTimeRef = useRef(0);

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressIndex.current = -1;
  };

  // 鎖定後揀選某一封（用作 sweep 拖曳）
  const selectUID = (uid: number) => {
    setSelectedUIDs((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
  };

  // --- Mobile swipe-to-reveal（左滑=垃圾桶/更多、右滑=已讀/封存） ---
  const swipeStartRef = useRef<{ x: number; y: number; uid: number; horizontal: boolean | null } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0); // 揭示位移 (px)，負=向左揭示垃圾桶
  const [draggingUID, setDraggingUID] = useState<number | null>(null);

  const handleTouchStart = (msg: MessageSummary) => (e: React.TouchEvent) => {
    if (isMultiSelectRef.current) return;
    const t = e.touches[0];
    swipeStartRef.current = { x: t.clientX, y: t.clientY, uid: msg.uid, horizontal: null };
    setDraggingUID(msg.uid);
  };

  const handleTouchMove = (msg: MessageSummary) => (e: React.TouchEvent) => {
    const start = swipeStartRef.current;
    if (!start || start.uid !== msg.uid) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    // 未判定方向：先分辨水平定垂直
    if (start.horizontal === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
      start.horizontal = Math.abs(dx) > Math.abs(dy);
    }

    if (start.horizontal) {
      let next = dx;
      const max = 160;
      next = Math.max(-max, Math.min(max, next));
      setSwipeOffset(next);
    }
    // CSS touch-action: pan-y 已限制垂直 roll；水平 swipe 不需 preventDefault
  };

  const handleTouchEnd = (msg: MessageSummary) => (e: React.TouchEvent) => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    setDraggingUID(null);
    if (!start || start.uid !== msg.uid) return;
    // 只有水平方向先觸發動作；且唔係響多選模式
    if (!start.horizontal || isMultiSelectRef.current) {
      setSwipeOffset(0);
      setSwipedUID(null);
      return;
    }

    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const threshold = 40;
    if (Math.abs(dx) < threshold) {
      // 唔夠過 threshold → 收返
      setSwipeOffset(0);
      setSwipedUID(null);
      return;
    }
    if (dx < 0) {
      // 向左滑 → 揭示垃圾桶
      setSwipedUID(msg.uid);
      setSwipeOffset(-160);
    } else {
      // 向右滑 → 揭示已讀/未讀
      setSwipedUID(msg.uid);
      setSwipeOffset(160);
    }
  };

  // 取得郵件清單
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['messages', accountId, currentFolder, page, limit, searchQuery],
    queryFn: () => mailApi.getMessages(currentFolder, page, limit, searchQuery, accountId),
    enabled: !!accountId,
    staleTime: 10000,
  });

  // 修改 Flag Mutation
  const flagMutation = useMutation({
    mutationFn: ({ uids, flags, op }: { uids: number[]; flags: string[]; op: 'add' | 'remove' }) =>
      mailApi.setFlags(currentFolder, uids, flags, op, accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  // 刪除郵件 Mutation
  const deleteMutation = useMutation({
    mutationFn: (uids: number[]) => mailApi.deleteMessages(currentFolder, uids, false, accountId),
    onSuccess: () => {
      setSelectedUIDs([]);
      if (selectedUID && selectedUIDs.includes(selectedUID)) {
        setSelectedUID(null);
      }
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  // 移動郵件 Mutation
  const moveMutation = useMutation({
    mutationFn: ({ uids, dest }: { uids: number[]; dest: string }) =>
      mailApi.moveMessages(currentFolder, uids, dest, accountId),
    onSuccess: () => {
      setSelectedUIDs([]);
      if (selectedUID) setSelectedUID(null);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
    onError: (err: any) => {
      setSwipeError(err?.message || '移動郵件失敗');
      setTimeout(() => setSwipeError(null), 3000);
    },
  });

  // 取得資料夾清單（供移動目的地）
  const { data: folders } = useQuery({
    queryKey: ['folders', accountId],
    queryFn: () => mailApi.getFolders(accountId),
    enabled: !!accountId,
    staleTime: 60000,
  });

  // 垃圾郵件資料夾名（specialUse=junk/spam 或名稱含 junk/spam）；搵唔到則為 undefined（唔顯示按鈕）
  const junkFolder =
    folders?.find((f) => f.specialUse === 'junk' || f.specialUse === 'spam')?.name ??
    folders?.find((f) => /junk|spam/i.test(f.name))?.name;

  // Desktop: Delete/Backspace 鍵刪除「而家睇緊嗰封」
  const deleteRef = useRef(deleteMutation);
  deleteRef.current = deleteMutation;
  const selectedUIDRef = useRef(selectedUID);
  selectedUIDRef.current = selectedUID;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // 忽略輸入框/內容可編輯區/Composer 聚焦，避免誤刪
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (tagName === 'input' || tagName === 'textarea' || target?.isContentEditable) return;
      const uid = selectedUIDRef.current;
      if (uid == null) return;
      e.preventDefault();
      deleteRef.current.mutate([uid], {
        onSuccess: () => setSelectedUID(null),
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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

  // Desktop multi-select (Ctrl/Cmd+click toggle, Shift+click range)
  const lastClickedIndexRef = useRef<number>(-1);
  const handleRowClick = (msg: MessageSummary, index: number, e: React.MouseEvent) => {
    // 長按（>=500ms）鎖定後釋放觸發嘅 click：吞掉，避免誤取消揀選
    if (Date.now() - pointerDownTimeRef.current >= 500) {
      e.preventDefault();
      return;
    }

    // 有揭示嘅 row：click 時先收返，唔開 viewer
    if (swipedUID !== null) {
      e.preventDefault();
      setSwipedUID(null);
      setSwipeOffset(0);
      return;
    }

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    // Mobile 多選模式：tap 加/減
    if (isMultiSelectRef.current) {
      e.preventDefault();
      setSelectedUIDs((prev) =>
        prev.includes(msg.uid) ? prev.filter((id) => id !== msg.uid) : [...prev, msg.uid]
      );
      return;
    }

    if (isCtrl) {
      // Ctrl/Cmd+click: 逐封加/減
      e.preventDefault();
      lastClickedIndexRef.current = index;
      setSelectedUIDs((prev) =>
        prev.includes(msg.uid) ? prev.filter((id) => id !== msg.uid) : [...prev, msg.uid]
      );
      return;
    }

    if (isShift) {
      // Shift+click: 選連續範圍
      e.preventDefault();
      const from = lastClickedIndexRef.current >= 0 ? lastClickedIndexRef.current : index;
      const to = index;
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      setSelectedUIDs((prev) => {
        const next = new Set(prev);
        for (let i = lo; i <= hi; i++) {
          const m = messages[i];
          if (m) next.add(m.uid);
        }
        return Array.from(next);
      });
      return;
    }

    // 普通 click: 開 viewer
    lastClickedIndexRef.current = index;
    setSelectedUID(msg.uid);
  };

  // Mobile 長按 → 進入多選模式
  const handlePointerDown = (index: number) => {
    pointerDownTimeRef.current = Date.now();
    if (isMultiSelectRef.current) {
      // 已鎖定：拖曳 sweep
      setIsMultiSelect(true);
      const m = messages[index];
      if (m) selectUID(m.uid);
      return;
    }
    cancelLongPress();
    longPressIndex.current = index;
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      isMultiSelectRef.current = true;
      setIsMultiSelect(true);
      const m = messages[index];
      if (m) selectUID(m.uid);
    }, 400);
  };

  // container-level pointermove：鎖定後 sweep 揀選
  const handleListPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isMultiSelectRef.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = el?.closest('[data-uid]') as HTMLElement | null;
    if (!row) return;
    const uid = Number(row.dataset.uid);
    if (!Number.isNaN(uid)) selectUID(uid);
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

  // 通訊錄批量解析：寄件人是否已在地址簿（用於顯示頭像/名稱）
  const senderEmails = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      const e = m.from?.[0]?.address?.toLowerCase()?.trim();
      if (e) set.add(e);
    }
    return Array.from(set).slice(0, 100);
  }, [messages]);
  const { data: contactMap } = useQuery({
    queryKey: ['contact-resolve-list', senderEmails.join(',')],
    queryFn: () => contactsApi.resolve(senderEmails),
    enabled: senderEmails.length > 0,
    staleTime: 30000,
  });

  return (
    <section
      className={`w-full lg:w-[380px] xl:w-[420px] bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col shrink-0 overflow-hidden min-w-0 max-w-full ${
        selectedUID !== null ? 'hidden lg:flex' : 'flex'
      }`}
    >
      {/* 操作錯誤提示 */}
      {swipeError && (
        <div className="px-3.5 py-2 bg-red-50 text-red-700 text-xs border-b border-red-200/60 flex items-center gap-2 shrink-0">
          <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
          {swipeError}
        </div>
      )}
      {/* 頂部操作欄 */}
      <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 shrink-0 bg-slate-50/70 dark:bg-slate-900/70 w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {isMultiSelect ? (
            <button
              onClick={() => {
                isMultiSelectRef.current = false;
                setIsMultiSelect(false);
                setSelectedUIDs([]);
              }}
              className="flex items-center gap-1 p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded-lg transition"
              title="完成 / 退出多選"
            >
              <X className="w-4 h-4" />
              <span className="text-xs font-semibold">完成</span>
            </button>
          ) : (
            <input
              type="checkbox"
              checked={messages.length > 0 && selectedUIDs.length === messages.length}
              onChange={handleSelectAll}
              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-0 cursor-pointer"
            />
          )}

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
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    moveMutation.mutate({ uids: selectedUIDs, dest: e.target.value });
                    e.target.value = '';
                  }
                }}
                className="max-w-[120px] text-xs border border-slate-200 dark:border-slate-700 rounded-lg px-1.5 py-1 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 outline-none"
                title="移動到資料夾"
                disabled={moveMutation.isPending}
              >
                <option value="" disabled>
                  {moveMutation.isPending ? '移動中...' : '移動到…'}
                </option>
                {folders
                  ?.filter((f) => f.name !== currentFolder)
                  .map((f) => (
                    <option key={f.name} value={f.name}>
                      {getFolderDisplayName(f)}
                    </option>
                  ))}
              </select>
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
      <div
        onPointerMove={handleListPointerMove}
        onPointerUp={() => {
          // 手指放開後停留喺多選模式，等用戶繼續 tap 加減
        }}
        className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80 w-full min-w-0 overscroll-contain"
      >
        {isLoading ? (
          <div className="p-8 text-center text-xs text-slate-400">正在讀取信件...</div>
        ) : messages.length === 0 ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center">
            <Inbox className="w-12 h-12 stroke-1 mb-2 text-slate-300 dark:text-slate-700" />
            <p className="text-xs">此資料夾沒有郵件</p>
          </div>
        ) : (
          messages.map((msg, index) => {
            const isSelected = selectedUID === msg.uid;
            const isChecked = selectedUIDs.includes(msg.uid);
            const fromName = msg.from?.[0]?.name || msg.from?.[0]?.address || '未知寄件者';

            return (
              <div
                key={msg.uid}
                className="relative overflow-hidden w-full"
              >
                {/* 揭示按鈕層 — 向左滑揭露（右邊：垃圾桶 + 垃圾郵件[若存在]） */}
                <div className="absolute inset-y-0 right-0 flex">
                  <button
                    onClick={() => {
                      deleteMutation.mutate([msg.uid], { onSuccess: () => setSelectedUID(null) });
                      setSwipedUID(null);
                      setSwipeOffset(0);
                    }}
                    className="w-[80px] bg-red-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                  >
                    <Trash2 className="w-5 h-5" />
                    垃圾桶
                  </button>
                  {junkFolder && (
                    <button
                      onClick={() => {
                        moveMutation.mutate({ uids: [msg.uid], dest: junkFolder });
                        setSwipedUID(null);
                        setSwipeOffset(0);
                      }}
                      className="w-[80px] bg-orange-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                    >
                      <AlertOctagon className="w-5 h-5" />
                      垃圾郵件
                    </button>
                  )}
                </div>

                {/* 揭示按鈕層 — 向右滑揭露（左邊：已讀） */}
                <div className="absolute inset-y-0 left-0 flex">
                  <button
                    onClick={() => {
                      flagMutation.mutate({ uids: [msg.uid], flags: ['\\Seen'], op: msg.unread ? 'add' : 'remove' });
                      setSwipedUID(null);
                      setSwipeOffset(0);
                    }}
                    className="w-[80px] bg-blue-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                  >
                    <MailCheck className="w-5 h-5" />
                    {msg.unread ? '已讀' : '未讀'}
                  </button>
                </div>

                {/* 郵件內容（translate-x revealing） */}
                <div
                  data-uid={msg.uid}
                  onClick={(e) => handleRowClick(msg, index, e)}
                  onPointerDown={() => handlePointerDown(index)}
                  onPointerUp={cancelLongPress}
                  onPointerMove={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onTouchStart={handleTouchStart(msg)}
                  onTouchMove={handleTouchMove(msg)}
                  onTouchEnd={handleTouchEnd(msg)}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{
                    touchAction: isMultiSelect ? 'none' : 'pan-y',
                    transform:
                      swipedUID === msg.uid || draggingUID === msg.uid
                        ? `translateX(${swipeOffset}px)`
                        : 'translateX(0)',
                    transition: draggingUID === msg.uid ? 'none' : 'transform 0.2s ease',
                  }}
                  className={`flex items-start gap-3 px-3.5 py-3 text-xs cursor-pointer transition select-none w-full min-w-0 bg-white dark:bg-slate-900 ${
                    isSelected
                      ? 'bg-blue-50/90 dark:bg-blue-950/50 border-l-4 border-blue-600'
                      : isChecked
                        ? 'bg-blue-100/40 dark:bg-blue-900/30 border-l-4 border-blue-400'
                        : ''
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
                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                      {(() => {
                        const email = msg.from?.[0]?.address?.toLowerCase();
                        const c = email ? (contactMap as any)?.[email] : null;
                        return c ? <ContactMiniAvatar contact={c} /> : null;
                      })()}
                      <span
                        className={`truncate text-[13px] md:text-sm ${
                          msg.unread ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        {(() => {
                          const email = msg.from?.[0]?.address?.toLowerCase();
                          const c = email ? (contactMap as any)?.[email] : null;
                          return c?.displayName || fromName;
                        })()}
                      </span>
                    </div>
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
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};

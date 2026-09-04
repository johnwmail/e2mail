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
  MessagesSquare,
  ChevronDown,
  Search,
} from 'lucide-react';
import { mailApi } from '../../api/mail';
import { contactsApi } from '../../api/addressBook';
import { useMailStore } from '../../stores/useMailStore';
import { useActiveAccount } from '../../hooks/useActiveAccount';
import { MessageSummary, FolderInfo, ThreadSummary, EmailAddress } from '../../types/api';
import { folderDisplayName, formatShortDate, useI18n } from '../../i18n';

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

interface ThreadRowProps {
  thread: ThreadSummary;
  contactMap: Record<string, any> | undefined;
  expanded: boolean;
  onToggle: () => void;
  selectedUIDs: number[];
  onToggleSelect: (uids: number[], checked: boolean) => void;
  activeUID: number | null;
  onOpen: (uid: number) => void;
}

const formatDateShort = (dateStr: string) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return formatShortDate(d);
};

const ThreadRow: React.FC<ThreadRowProps> = ({
  thread, contactMap, expanded, onToggle, selectedUIDs, onToggleSelect, activeUID, onOpen,
}) => {
  const { t } = useI18n();
  const memberUIDs = thread.messages.map((m) => m.uid);
  const allChecked = memberUIDs.length > 0 && memberUIDs.every((u) => selectedUIDs.includes(u));
  const newest = thread.messages.reduce((a, b) => (new Date(a.date) >= new Date(b.date) ? a : b), thread.messages[0]);
  if (!newest) return null;

  const senderLabel = (addrs: string[]) => {
    const names = addrs.slice(0, 2).map((a) => {
      const c = contactMap?.[a.toLowerCase()];
      if (c?.displayName) return c.displayName;
      const byName = newest.from?.find((f) => f.address?.toLowerCase() === a.toLowerCase())?.name;
      return byName || a.split('@')[0];
    });
    return names.join(', ') + (addrs.length > 2 ? ` +${addrs.length - 2}` : '');
  };

  return (
    <div className={`${thread.unreadCount > 0 ? '' : ''}`}>
      <div
        className={`flex items-start gap-2.5 px-3 py-2.5 cursor-pointer transition select-none w-full min-w-0 ${
          activeUID !== null && memberUIDs.includes(activeUID)
            ? 'bg-blue-50/90 dark:bg-blue-950/50 border-l-4 border-blue-600'
            : allChecked
              ? 'bg-blue-100/40 dark:bg-blue-900/30 border-l-4 border-blue-400'
              : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
        }`}
        onClick={() => onOpen(newest.uid)}
      >
        <input
          type="checkbox"
          checked={allChecked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleSelect(memberUIDs, e.target.checked)}
          className="w-4 h-4 mt-1 rounded border-slate-300 text-blue-600 focus:ring-0 cursor-pointer shrink-0"
        />
        {thread.messageCount > 1 ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="p-2 -m-1 shrink-0 text-slate-400 hover:text-slate-600"
            title={expanded ? t('mailList.collapseThread') : t('mailList.expandThread')}
            aria-label={expanded ? t('mailList.collapseThread') : t('mailList.expandThread')}
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className={`truncate text-[13px] md:text-sm ${thread.unreadCount > 0 ? 'font-bold text-slate-900 dark:text-white' : 'text-slate-700 dark:text-slate-300'}`}>
              {senderLabel(thread.senders)}
              {thread.messageCount > 1 && (
                <span className="ml-1.5 text-[10px] text-slate-400 font-normal">({thread.messageCount})</span>
              )}
            </span>
            <span className="text-[11px] text-slate-400 shrink-0 font-mono">{formatDateShort(newest.date)}</span>
          </div>
          <div className={`truncate text-xs mt-0.5 ${thread.unreadCount > 0 ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-600 dark:text-slate-400'}`}>
            {thread.subject || t('mailList.noSubject')}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400 min-w-0 mt-0.5">
            {thread.hasAttachment && <Paperclip className="w-3 h-3 shrink-0" />}
            <span className="truncate">{(newest.snippet || '').slice(0, 90)}</span>
          </div>
        </div>
        {thread.unreadCount > 0 && (
          <div className="shrink-0 mt-1.5 flex flex-col items-center gap-0.5">
            <div className="w-2.5 h-2.5 rounded-full bg-blue-600" />
            {thread.unreadCount > 1 && <span className="text-[9px] font-bold text-blue-600">{thread.unreadCount}</span>}
          </div>
        )}
      </div>
      {expanded && thread.messages.length > 1 && (
        <div className="bg-slate-50 dark:bg-slate-900 border-y border-slate-100 dark:border-slate-800">
          {thread.messages.map((m) => (
            <div
              key={m.uid}
              onClick={(e) => {
                e.stopPropagation();
                onOpen(m.uid);
              }}
              className={`flex items-center gap-2.5 pl-14 pr-3 py-1.5 text-xs cursor-pointer min-w-0 ${
                activeUID === m.uid ? 'bg-blue-100/50 dark:bg-blue-950/50 font-semibold' : 'hover:bg-slate-100/70 dark:hover:bg-slate-800/70'
              }`}
            >
              <span className={`truncate flex-1 min-w-0 ${m.unread ? 'font-semibold text-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400'}`}>
                {m.from?.[0]?.name || m.from?.[0]?.address?.split('@')[0] || '?'}
              </span>
              {m.hasAttachment && <Paperclip className="w-3 h-3 text-slate-400 shrink-0" />}
              {m.unread && <div className="w-2 h-2 rounded-full bg-blue-600 shrink-0" />}
              <span className="text-[10px] text-slate-400 font-mono shrink-0">{formatDateShort(m.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ==== 即時本機搜尋過濾（對已載入嘅 list 打字即時縮窄） ====

interface LocalToken {
  op: string;
  val: string;
}

  // 以空白切分，支援雙引號/單引號同 operator（word:value）
  // 注意：雙引號內要用 [^"\\]（排除反斜線），令 \\. 唯一負責反斜線，避免 ReDoS 指數回溯
  function tokenizeLocalQuery(q: string): LocalToken[] {
    const tokens: LocalToken[] = [];
    const re = /([a-z-]+:)?("(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi;
    let m: RegExpExecArray | null;
    const lower = q;
    while ((m = re.exec(lower))) {
      const op = m[1] ? m[1].toLowerCase() : '';
      const val = (m[2] || '').replace(/^["']|["']$/g, '');
      if (val) tokens.push({ op, val });
    }
    return tokens;
  }

function containsAddr(list: EmailAddress[] | undefined, needle: string): boolean {
  const n = needle.toLowerCase();
  return (list || []).some((e) => e.address.toLowerCase().includes(n) || e.name.toLowerCase().includes(n));
}

// 支援純文字（AND）、from:/to:/subject:/body:/text:、is:unread/read/starred、has:attachment
function matchesLocalQuery(msg: MessageSummary, query: string): boolean {
  const tokens = tokenizeLocalQuery(query);
  if (!tokens.length) return true;
  const ops = new Set<string>(['from', 'to', 'subject', 'cc', 'bcc', 'body', 'text', 'is', 'has']);

  // 純文字（無 operator）：subject/from/to/snippet 都要包含（AND）
  const plains = tokens.filter((t) => !t.op);
  if (plains.length) {
    const hay = [
      msg.subject || '',
      msg.snippet || '',
      ...(msg.from || []).flatMap((f) => [f.name, f.address]),
      ...(msg.to || []).flatMap((t) => [t.name, t.address]),
    ]
      .join(' ')
      .toLowerCase();
    if (!plains.every((t) => hay.includes(t.val.toLowerCase()))) return false;
  }

  for (const t of tokens) {
    const val = t.val.toLowerCase();
    switch (t.op) {
      case 'from':
        if (!containsAddr(msg.from, t.val)) return false;
        break;
      case 'to':
        if (!containsAddr(msg.to, t.val)) return false;
        break;
      case 'subject':
        if (!(msg.subject || '').toLowerCase().includes(val)) return false;
        break;
      case 'body':
      case 'text':
        // 只有 snippet（預覽層），冇全文；唔達就唔顯示，等伺服器全文補充
        if (!(msg.snippet || '').toLowerCase().includes(val) && !(msg.subject || '').toLowerCase().includes(val)) return false;
        break;
      case 'is':
        if (val === 'unread' && !msg.unread) return false;
        if (val === 'read' && msg.unread) return false;
        if (val === 'starred' && !msg.starred) return false;
        break;
      case 'has':
        if (val === 'attachment' && !msg.hasAttachment) return false;
        break;
      default:
        if (!ops.has(t.op)) {
          // 未支援嘅 operator（after:/before:/larger: 等）→ 唔做本機過濾，交返伺服器
          if (!(msg.snippet || '').toLowerCase().includes(val) && !(msg.subject || '').toLowerCase().includes(val)) return false;
        }
    }
  }
  return true;
}

function matchesLocalThread(thread: ThreadSummary, query: string): boolean {
  if (thread.messages.length) return thread.messages.some((m) => matchesLocalQuery(m, query));
  return matchesLocalQuery(
    {
      uid: 0,
      messageId: '',
      subject: thread.subject,
      date: thread.date,
      from: [],
      to: [],
      flags: [],
      unread: thread.unreadCount > 0,
      starred: thread.starred,
      hasAttachment: thread.hasAttachment,
      size: 0,
      snippet: thread.messages[0]?.snippet || '',
    },
    query
  );
}

export const MessageList: React.FC = () => {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const activeAccount = useActiveAccount();
  const accountId = activeAccount?.id;
  const {
    currentFolder,
    setCurrentFolder,
    selectedUID,
    setSelectedUID,
    setSelectedFolder,
    searchQuery,
    searchInput,
    clearSearch,
    page,
    setPage,
    limit,
    unreadView,
    listMode,
  } = useMailStore();
  const isUnreadView = unreadView;
  const threadMode = listMode === 'threads' && !isUnreadView;
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const toggleThread = (id: string) =>
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
  const REVEAL_W = 160;
  const REVEAL_HALF = REVEAL_W / 2; // 80：過半先停留喺揭示位，否則彈返正中
  const swipeStartRef = useRef<{ x: number; y: number; uid: number; horizontal: boolean | null; base: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0); // 目前顯示位移（拖曳中=即時，彈定後=±REVEAL_W/0）
  const [draggingUID, setDraggingUID] = useState<number | null>(null);

  const closeSwipe = () => {
    setSwipeOffset(0);
    setSwipedUID(null);
  };

  const handleTouchStart = (msg: MessageSummary) => (e: React.TouchEvent) => {
    if (isMultiSelectRef.current) return;
    const t = e.touches[0];
    // 起點位移：若呢行已揭示，由當前停留位開始計（左滑傾斜量相對），咁先可以用同一方向拖返去正中
    const base = swipedUID === msg.uid ? swipeOffset : 0;
    swipeStartRef.current = { x: t.clientX, y: t.clientY, uid: msg.uid, horizontal: null, base };
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
      let next = start.base + dx;
      next = Math.max(-REVEAL_W, Math.min(REVEAL_W, next));
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
      closeSwipe();
      return;
    }

    const t = e.changedTouches[0];
    let final = start.base + (t.clientX - start.x);
    final = Math.max(-REVEAL_W, Math.min(REVEAL_W, final));
    // 過半（±80）先停留喺揭示位；否則一律彈返正中（0）
    if (final > -REVEAL_HALF && final < REVEAL_HALF) {
      closeSwipe();
      return;
    }
    setSwipedUID(msg.uid);
    setSwipeOffset(final <= -REVEAL_HALF ? -REVEAL_W : REVEAL_W);
  };

  // --- Thread 行 swipe-to-reveal（同 flat 一致，但以 threadId 為鍵） ---
  const threadSwipeStartRef = useRef<{ x: number; y: number; threadId: string; horizontal: boolean | null; base: number } | null>(null);
  const [threadSwipeOffset, setThreadSwipeOffset] = useState(0);
  const [draggingThreadId, setDraggingThreadId] = useState<string | null>(null);
  const [swipedThreadId, setSwipedThreadId] = useState<string | null>(null);

  const closeThreadSwipe = () => {
    setThreadSwipeOffset(0);
    setSwipedThreadId(null);
  };

  const handleThreadTouchStart = (thread: ThreadSummary) => (e: React.TouchEvent) => {
    if (isMultiSelectRef.current) return;
    const t = e.touches[0];
    const base = swipedThreadId === thread.threadId ? threadSwipeOffset : 0;
    threadSwipeStartRef.current = { x: t.clientX, y: t.clientY, threadId: thread.threadId, horizontal: null, base };
    setDraggingThreadId(thread.threadId);
  };

  const handleThreadTouchMove = (thread: ThreadSummary) => (e: React.TouchEvent) => {
    const start = threadSwipeStartRef.current;
    if (!start || start.threadId !== thread.threadId) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (start.horizontal === null && (Math.abs(dx) > 12 || Math.abs(dy) > 12)) {
      start.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (start.horizontal) {
      setThreadSwipeOffset(Math.max(-REVEAL_W, Math.min(REVEAL_W, start.base + dx)));
    }
  };

  const handleThreadTouchEnd = (thread: ThreadSummary) => (e: React.TouchEvent) => {
    const start = threadSwipeStartRef.current;
    threadSwipeStartRef.current = null;
    setDraggingThreadId(null);
    if (!start || start.threadId !== thread.threadId) return;
    if (!start.horizontal || isMultiSelectRef.current) {
      closeThreadSwipe();
      return;
    }
    const t = e.changedTouches[0];
    let final = start.base + (t.clientX - start.x);
    final = Math.max(-REVEAL_W, Math.min(REVEAL_W, final));
    if (final > -REVEAL_HALF && final < REVEAL_HALF) {
      closeThreadSwipe();
      return;
    }
    setSwipedThreadId(thread.threadId);
    setThreadSwipeOffset(final <= -REVEAL_HALF ? -REVEAL_W : REVEAL_W);
  };

  const clearThreadSwipe = () => {
    closeThreadSwipe();
  };

  // 清單上下文改變（資料夾/搜尋/分頁/模式）時收返所有揭示，避免殘留 swiped 遮檔開信
  useEffect(() => {
    closeSwipe();
    closeThreadSwipe();
  }, [currentFolder, searchQuery, page, limit, listMode, unreadView]);

  // 正常資料夾清單
  const {
    data: folderData,
    isLoading: folderLoading,
    isFetching: folderFetching,
    refetch: folderRefetch,
  } = useQuery({
    queryKey: ['messages', accountId, currentFolder, page, limit, searchQuery, listMode],
    queryFn: () => mailApi.getMessages(currentFolder, page, limit, searchQuery, accountId, listMode === 'threads'),
    enabled: !!accountId && !unreadView,
    staleTime: 10000,
    // 搜尋途中保留舊結果，避免 list 「閃白」；新結果返嚟先取代
    placeholderData: (previousData) => previousData,
  });

  // 未讀 Smart 列表（純 App 前端合併）：逐 folder 用現有 getMessages(folder, q=is:unread)，再合併排序分頁
  const {
    data: unreadData,
    isLoading: unreadLoading,
    isFetching: unreadFetching,
    refetch: unreadRefetch,
  } = useQuery({
    queryKey: ['unread-aggregate', accountId, page, limit],
    queryFn: () => mailApi.getUnread(page, limit, accountId),
    enabled: !!accountId && unreadView,
    staleTime: 0,
    placeholderData: (previousData) => previousData,
  });

  const data = isUnreadView ? unreadData : folderData;
  const isLoading = isUnreadView ? unreadLoading : folderLoading;
  const isFetching = isUnreadView ? unreadFetching : folderFetching;
  const refetch = isUnreadView ? unreadRefetch : folderRefetch;

  // 未讀虛擬列表下，每封郵件屬唔同真 folder；用呢個 map 搵返每封嘅來源資料夾
  const folderByUID = useMemo(() => {
    const map = new Map<number, string>();
    for (const m of data?.messages || []) {
      if (m.uid && m.folder) map.set(m.uid, m.folder);
    }
    return map;
  }, [data]);

  const folderForUID = (uid: number): string => {
    if (isUnreadView) {
      const f = folderByUID.get(uid);
      if (f) return f;
    }
    return currentFolder;
  };

  // 將一組 uid 依真 folder 分組（未讀列表可跨 folder；正常情況淨係得一組 = currentFolder）
  const groupUidsByFolder = (uids: number[]): { folder: string; uids: number[] }[] => {
    const map = new Map<string, number[]>();
    for (const uid of uids) {
      const f = folderForUID(uid);
      if (!f) continue;
      const arr = map.get(f) || [];
      arr.push(uid);
      map.set(f, arr);
    }
    return [...map.entries()].map(([folder, ids]) => ({ folder, uids: ids }));
  };

  // 修改 Flag Mutation
  const flagMutation = useMutation({
    mutationFn: ({ uids, flags, op }: { uids: number[]; flags: string[]; op: 'add' | 'remove' }) =>
      Promise.all(groupUidsByFolder(uids).map((g) => mailApi.setFlags(g.folder, g.uids, flags, op, accountId))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  // 由清單移除（刪除/搬走）某些 uid 後，若而家揀中嘅被封移除，自動揀下一封，唔留空白 viewer
  const reselectAfterRemoval = (removed: number[]) => {
    const deletedSet = new Set(removed);
    const needReselect = selectedUID != null && deletedSet.has(selectedUID);
    if (!needReselect) return;
    let nextUID: number | null = null;
    let nextFolder: string | null = null;
    if (isUnreadView) {
      const idx = displayMessages.findIndex((m) => m.uid === selectedUID);
      const realIdx = idx !== -1 ? idx : displayMessages.findIndex((m) => deletedSet.has(m.uid));
      let cand: MessageSummary | null = null;
      for (let i = (realIdx !== -1 ? realIdx : 0) + 1; i < displayMessages.length; i++) if (!deletedSet.has(displayMessages[i].uid)) { cand = displayMessages[i]; break; }
      if (!cand && realIdx !== -1) for (let i = realIdx - 1; i >= 0; i--) if (!deletedSet.has(displayMessages[i].uid)) { cand = displayMessages[i]; break; }
      if (!cand) {
        const remain = displayMessages.filter((m) => !deletedSet.has(m.uid));
        cand = remain[0] ?? null;
      }
      if (cand) { nextUID = cand.uid; nextFolder = (cand as any).folder ?? null; }
    } else if (threadMode) {
      const tIdx = displayThreads.findIndex((t) => t.messages.some((m) => m.uid === selectedUID));
      if (tIdx !== -1) {
        // 剩餘 threads（成個 thread 被刪就消失）
        const remainThreads = displayThreads.filter((t) => !t.messages.every((m) => deletedSet.has(m.uid)));
        // 同 thread 內仲有未刪嘅 message 就留喺同 thread（揀下一個 message）
        const curThread = displayThreads[tIdx];
        const remainMsgsInThread = curThread ? curThread.messages.filter((m) => !deletedSet.has(m.uid)) : [];
        if (remainMsgsInThread.length > 0) {
          const newest = remainMsgsInThread.reduce((a, b) => (new Date(a.date) >= new Date(b.date) ? a : b), remainMsgsInThread[0]);
          nextUID = newest.uid;
        } else {
          // 成個 thread 冇咗，揀下一個 thread
          let candThread: typeof displayThreads[0] | null = null;
          // 搵原位置之後第一個未刪嘅 thread
          for (let i = tIdx + 1; i < displayThreads.length; i++) if (!displayThreads[i].messages.every((m) => deletedSet.has(m.uid))) { candThread = displayThreads[i]; break; }
          if (!candThread) for (let i = tIdx - 1; i >= 0; i--) if (!displayThreads[i].messages.every((m) => deletedSet.has(m.uid))) { candThread = displayThreads[i]; break; }
          if (!candThread) candThread = remainThreads[0] ?? null;
          if (candThread) {
            const newest = candThread.messages.reduce((a, b) => (new Date(a.date) >= new Date(b.date) ? a : b), candThread.messages[0]);
            nextUID = newest.uid;
          }
        }
      }
    } else {
      const idx = displayMessages.findIndex((m) => m.uid === selectedUID);
      let cand: MessageSummary | null = null;
      for (let i = idx + 1; i < displayMessages.length; i++) if (!deletedSet.has(displayMessages[i].uid)) { cand = displayMessages[i]; break; }
      if (!cand) for (let i = idx - 1; i >= 0; i--) if (!deletedSet.has(displayMessages[i].uid)) { cand = displayMessages[i]; break; }
      if (!cand) cand = displayMessages.filter((m) => !deletedSet.has(m.uid))[0] ?? null;
      if (cand) nextUID = cand.uid;
    }
    if (nextUID != null) {
      if (isUnreadView && nextFolder) setSelectedFolder(nextFolder);
      else if (!isUnreadView) setSelectedFolder(null);
      setSelectedUID(nextUID);
    } else {
      setSelectedFolder(null);
      setSelectedUID(null);
    }
  };

  // 刪除郵件 Mutation（刪完自動揀下一封，唔留空）
  const deleteMutation = useMutation({
    mutationFn: (uids: number[]) =>
      Promise.all(groupUidsByFolder(uids).map((g) => mailApi.deleteMessages(g.folder, g.uids, false, accountId))),
    onSuccess: (_data, uids: number[]) => {
      setSelectedUIDs([]);
      reselectAfterRemoval(uids);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
  });

  // 移動郵件 Mutation（搬走而家開緊嗰封後，自動揀下一封）
  const moveMutation = useMutation({
    mutationFn: ({ uids, dest }: { uids: number[]; dest: string }) =>
      Promise.all(groupUidsByFolder(uids).map((g) => mailApi.moveMessages(g.folder, g.uids, dest, accountId))),
    onSuccess: (_data, vars) => {
      setSelectedUIDs([]);
      reselectAfterRemoval(vars.uids);
      queryClient.invalidateQueries({ queryKey: ['messages', accountId, currentFolder] });
      queryClient.invalidateQueries({ queryKey: ['unread-aggregate', accountId] });
      queryClient.invalidateQueries({ queryKey: ['folders', accountId] });
    },
    onError: (err: any) => {
      setSwipeError(err?.message || t('mailList.moveFailed'));
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
      deleteRef.current.mutate([uid]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleSelectAll = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.checked) {
      if (threadMode) {
        setSelectedUIDs(threads.flatMap((t) => t.messages.map((m) => m.uid)));
      } else if (data?.messages) {
        setSelectedUIDs(data.messages.map((m) => m.uid));
      }
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

  // thread 模式：成組 UID 加/減
  const toggleThreadSelect = (uids: number[], checked: boolean) => {
    setSelectedUIDs((prev) => {
      const set = new Set(prev);
      for (const u of uids) {
        if (checked) set.add(u);
        else set.delete(u);
      }
      return Array.from(set);
    });
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

    // 普通 click: 開 viewer —— 未讀虛擬列表用訊息本身嘅真 folder 開，保持喺未讀檢視
    lastClickedIndexRef.current = index;
    if (isUnreadView) {
      const f = folderForUID(msg.uid);
      if (f) setSelectedFolder(f);
      else setSelectedFolder(null);
    } else {
      setSelectedFolder(null);
    }
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
      closeSwipe();
      closeThreadSwipe();
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

  const messages = data?.messages || [];
  const threads = useMemo(() => data?.threads || [], [data]);
  const totalPages = data?.totalPages || 1;

  // 即時本機過濾：資料未「完全對應個草稿」時（searchInput 未 commit 成 searchQuery 或緊 fetching），
  // 對已載入嘅 list 用 searchInput 即刻縮窄；一旦伺服器返到權威結果就停用，避免「body-only match」被誤刪。
  const inputTrim = searchInput.trim();
  const isFreshForInput = inputTrim === searchQuery && !isFetching;
  // 未讀列表係 App 前端合併好嘅（server 唔理 q），所以只要有字就永遠本機過濾；
  // 正常列表先至用「權威結果就停用」嚟避免 body-only match 被誤刪。
  const applyLocalPreview = isUnreadView ? inputTrim !== '' : !isFreshForInput;
  const displayMessages = useMemo(() => {
    if (!applyLocalPreview || !inputTrim) return messages;
    return messages.filter((m) => matchesLocalQuery(m, inputTrim));
  }, [messages, applyLocalPreview, inputTrim]);
  const displayThreads = useMemo(() => {
    if (!applyLocalPreview || !inputTrim) return threads;
    return threads.filter((t) => matchesLocalThread(t, inputTrim));
  }, [threads, applyLocalPreview, inputTrim]);

  // 桌面分割視圖：每個清單上下文（帳號/資料夾/未讀/分頁/模式/搜尋）首次載入時自動選第一項，
  // 右側 viewer 唔會空白；mobile（<lg）唔自動選，避免一入資料夾清單就被 viewer 覆蓋。
  const autoSelectedCtxRef = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId || isLoading || !data) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) return;
    const ctx = `${accountId}|${isUnreadView ? 'unread' : currentFolder}|${listMode}|${page}|${searchQuery}`;
    if (autoSelectedCtxRef.current === ctx) return;
    autoSelectedCtxRef.current = ctx;
    if (selectedUID != null) return;
    if (threadMode) {
      const firstThread = displayThreads[0];
      if (!firstThread || firstThread.messages.length === 0) return;
      const newest = firstThread.messages.reduce(
        (a, b) => (new Date(a.date) >= new Date(b.date) ? a : b),
        firstThread.messages[0]
      );
      setSelectedFolder(null);
      setSelectedUID(newest.uid);
    } else {
      const first = displayMessages[0];
      if (!first) return;
      setSelectedFolder(isUnreadView ? folderForUID(first.uid) : null);
      setSelectedUID(first.uid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, data, isLoading, isUnreadView, currentFolder, listMode, page, searchQuery, threadMode, displayMessages, displayThreads, selectedUID]);

  // 預覽期間顯示「即時縮窄後」嘅數量；權威結果返到先顯示伺服器總數
  const resultCount = applyLocalPreview
    ? threadMode
      ? displayThreads.length
      : displayMessages.length
    : data?.total ?? 0;

  // 通訊錄批量解析：寄件人是否已在地址簿（用於顯示頭像/名稱）
  const senderEmails = useMemo(() => {
    const set = new Set<string>();
    const collect = (m: MessageSummary) => {
      const e = m.from?.[0]?.address?.toLowerCase()?.trim();
      if (e) set.add(e);
    };
    for (const m of messages) collect(m);
    for (const t of threads) for (const m of t.messages) collect(m);
    return Array.from(set).slice(0, 100);
  }, [messages, threads]);
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
              title={t('mailList.doneMulti')}
            >
              <X className="w-4 h-4" />
              <span className="text-xs font-semibold">{t('common.confirm')}</span>
            </button>
          ) : (
            <input
              type="checkbox"
              checked={
                listMode === 'threads'
                  ? displayThreads.length > 0 && displayThreads.every((t) => t.messages.every((m) => selectedUIDs.includes(m.uid)))
                  : displayMessages.length > 0 && selectedUIDs.length === displayMessages.length
              }
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
                title={t('mailList.markRead')}
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
                title={t('mailList.markUnread')}
              >
                <Mail className="w-4 h-4" />
              </button>
              <button
                onClick={() => deleteMutation.mutate(selectedUIDs)}
                className="p-1.5 text-slate-600 hover:text-red-600 hover:bg-slate-200/60 rounded-lg transition"
                title={t('mailList.deleteSelected')}
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
                title={t('mailList.moveToFolder')}
                disabled={moveMutation.isPending}
              >
                <option value="" disabled>
                  {moveMutation.isPending ? t('mailList.moving') : t('mailList.moveTo')}
                </option>
                {folders
                  ?.filter((f) => f.name !== currentFolder)
                  .map((f) => (
                    <option key={f.name} value={f.name}>
                      {folderDisplayName(f.name, f.specialUse)}
                    </option>
                  ))}
              </select>
            </div>
          ) : (
            <span className="text-xs font-medium text-slate-500 truncate">
              {resultCount ? (threadMode ? t('mailList.threadCount', { count: resultCount }) : t('mailList.messageCount', { count: resultCount })) : (threadMode ? t('mailList.conversations') : t('mailList.messages'))}
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
            title={t('common.refresh')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 搜尋結果提示列（進行搜尋時顯示；即時預覽階段都顯示） */}
      {(searchQuery || searchInput.trim()) && (
        <div className="px-3.5 py-2 border-b border-blue-100 dark:border-blue-900/40 bg-blue-50/60 dark:bg-blue-950/30 flex items-center gap-2 shrink-0 text-xs text-blue-800 dark:text-blue-200">
          <Search className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate flex-1 min-w-0">
             {t('mailList.searchResults', { query: searchInput.trim() || searchQuery, count: resultCount })}
          </span>
          <button
            onClick={() => clearSearch()}
            className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 transition shrink-0"
            title={t('mailList.clearSearch')}
            aria-label={t('mailList.clearSearch')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {/* 郵件清單容器 */}
      <div
        onPointerMove={handleListPointerMove}
        onPointerUp={() => {
          // 手指放開後停留喺多選模式，等用戶繼續 tap 加減
        }}
        className="flex-1 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/80 w-full min-w-0 overscroll-contain"
      >
        {isLoading ? (
          <div className="p-8 text-center text-xs text-slate-400">{t('mailList.loading')}</div>
        ) : threadMode ? (
          displayThreads.length === 0 ? (
            <div className="p-12 text-center text-slate-400 flex flex-col items-center">
              <MessagesSquare className="w-12 h-12 stroke-1 mb-2 text-slate-300 dark:text-slate-700" />
              <p className="text-xs">{searchInput.trim() ? t('mailList.noMatchingThreads') : t('mailList.noThreads')}</p>
            </div>
          ) : (
            displayThreads.map((thread) => {
              const tUids = thread.messages.map((m) => m.uid);
              return (
                <div key={thread.threadId} className="relative overflow-hidden w-full">
                  {/* 揭示按鈕層 — 向左滑揭露（右邊：垃圾桶 + 垃圾郵件[若存在]） */}
                  <div className="absolute inset-y-0 right-0 flex">
                    <button
                      onClick={() => {
                        deleteMutation.mutate(tUids);
                        clearThreadSwipe();
                      }}
                      className="w-[80px] bg-red-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                    >
                      <Trash2 className="w-5 h-5" />
                      {t('folders.trash')}
                    </button>
                    {junkFolder && (
                      <button
                        onClick={() => {
                          moveMutation.mutate({ uids: tUids, dest: junkFolder });
                          clearThreadSwipe();
                        }}
                        className="w-[80px] bg-orange-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                      >
                        <AlertOctagon className="w-5 h-5" />
                        {t('folders.junk')}
                      </button>
                    )}
                  </div>

                  {/* 揭示按鈕層 — 向右滑揭露（左邊：已讀/未讀） */}
                  <div className="absolute inset-y-0 left-0 flex">
                    <button
                      onClick={() => {
                        flagMutation.mutate({ uids: tUids, flags: ['\\Seen'], op: thread.unreadCount > 0 ? 'add' : 'remove' });
                        clearThreadSwipe();
                      }}
                      className="w-[80px] bg-blue-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                    >
                      <MailCheck className="w-5 h-5" />
                      {thread.unreadCount > 0 ? t('mailList.read') : t('mailList.unread')}
                    </button>
                  </div>

                  {/* Thread 內容（translate-x revealing） */}
                  <div
                    className="bg-white dark:bg-slate-900 w-full"
                    style={{
                      touchAction: isMultiSelect ? 'none' : 'pan-y',
                      transform:
                        draggingThreadId === thread.threadId ||
                        (swipedThreadId === thread.threadId && draggingThreadId === null)
                          ? `translateX(${threadSwipeOffset}px)`
                          : 'translateX(0)',
                      transition: draggingThreadId === thread.threadId ? 'none' : 'transform 0.2s ease',
                    }}
                    onTouchStart={handleThreadTouchStart(thread)}
                    onTouchMove={handleThreadTouchMove(thread)}
                    onTouchEnd={handleThreadTouchEnd(thread)}
                    onContextMenu={(e) => e.preventDefault()}
                  >
                    <ThreadRow
                      thread={thread}
                      contactMap={contactMap}
                      expanded={expandedThreads.has(thread.threadId)}
                      onToggle={() => toggleThread(thread.threadId)}
                      selectedUIDs={selectedUIDs}
                      onToggleSelect={toggleThreadSelect}
                      activeUID={selectedUID}
                      onOpen={(uid) => {
                        if (swipedThreadId !== null) {
                          clearThreadSwipe();
                          return;
                        }
                        setSelectedUID(uid);
                      }}
                    />
                  </div>
                </div>
              );
            })
          )
        ) : displayMessages.length === 0 ? (
          <div className="p-12 text-center text-slate-400 flex flex-col items-center">
            <Inbox className="w-12 h-12 stroke-1 mb-2 text-slate-300 dark:text-slate-700" />
            <p className="text-xs">
              {searchInput.trim()
                ? t('mailList.noMatchingMessages')
                : isUnreadView
                  ? t('mailList.noUnread')
                  : t('mailList.noMessages')}
            </p>
          </div>
        ) : (
          displayMessages.map((msg, index) => {
            const isSelected = selectedUID === msg.uid;
            const isChecked = selectedUIDs.includes(msg.uid);
            const fromName = msg.from?.[0]?.name || msg.from?.[0]?.address || t('mailList.unknownSender');

            return (
              <div
                key={msg.uid}
                className="relative overflow-hidden w-full"
              >
                {/* 揭示按鈕層 — 向左滑揭露（右邊：垃圾桶 + 垃圾郵件[若存在]） */}
                <div className="absolute inset-y-0 right-0 flex">
                  <button
                    onClick={() => {
                      deleteMutation.mutate([msg.uid]);
                      setSwipedUID(null);
                      setSwipeOffset(0);
                    }}
                    className="w-[80px] bg-red-500 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-semibold h-full"
                  >
                    <Trash2 className="w-5 h-5" />
                    {t('folders.trash')}
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
                      {t('folders.junk')}
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
                    {msg.unread ? t('mailList.read') : t('mailList.unread')}
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
                      draggingUID === msg.uid ||
                      (swipedUID === msg.uid && draggingUID === null)
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
                      {formatDateShort(msg.date)}
                    </span>
                  </div>

                  <div
                    className={`truncate text-xs mb-1 ${
                      msg.unread
                        ? 'font-semibold text-slate-800 dark:text-slate-100'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {msg.subject || t('mailList.noSubject')}
                  </div>

                  {isUnreadView && msg.folder && (
                    <div className="mb-1 flex items-center gap-1">
                      <FolderInput className="w-3 h-3 text-slate-400 shrink-0" />
                      <span className="text-[10px] text-slate-400 truncate">{folderDisplayName(msg.folder)}</span>
                    </div>
                  )}

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

import type { EmailAddress, MessageSummary, ThreadSummary } from '../types/api';

export interface LocalToken {
  op: string;
  val: string;
}

export function tokenizeLocalQuery(q: string): LocalToken[] {
  const tokens: LocalToken[] = [];
  const re = /([a-z-]+:)?("(?:\\.|[^"\\])*"|'[^']*'|\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const op = m[1] ? m[1].toLowerCase().replace(/:$/, '') : '';
    const val = (m[2] || '').replace(/^["']|["']$/g, '');
    if (val) tokens.push({ op, val });
  }
  return tokens;
}

function containsAddr(list: EmailAddress[] | undefined, needle: string): boolean {
  const n = needle.toLowerCase();
  return (list || []).some(
    (e) => e.address.toLowerCase().includes(n) || e.name.toLowerCase().includes(n)
  );
}

export function matchesLocalQuery(msg: MessageSummary, query: string): boolean {
  const tokens = tokenizeLocalQuery(query);
  if (!tokens.length) return true;
  const ops = new Set<string>(['from', 'to', 'subject', 'cc', 'bcc', 'body', 'text', 'is', 'has']);

  const plains = tokens.filter((t) => !t.op);
  if (plains.length) {
    const hay = [
      msg.subject || '',
      msg.snippet || '',
      ...(msg.from || []).flatMap((f) => [f.name, f.address]),
      ...(msg.to || []).flatMap((to) => [to.name, to.address]),
    ]
      .join(' ')
      .toLowerCase();
    if (!plains.every((t) => hay.includes(t.val.toLowerCase()))) return false;
  }

  for (const tok of tokens) {
    const val = tok.val.toLowerCase();
    switch (tok.op) {
      case 'from':
        if (!containsAddr(msg.from, tok.val)) return false;
        break;
      case 'to':
        if (!containsAddr(msg.to, tok.val)) return false;
        break;
      case 'subject':
        if (!(msg.subject || '').toLowerCase().includes(val)) return false;
        break;
      case 'body':
      case 'text':
        if (
          !(msg.snippet || '').toLowerCase().includes(val) &&
          !(msg.subject || '').toLowerCase().includes(val)
        ) {
          return false;
        }
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
        if (!ops.has(tok.op)) {
          if (
            !(msg.snippet || '').toLowerCase().includes(val) &&
            !(msg.subject || '').toLowerCase().includes(val)
          ) {
            return false;
          }
        }
    }
  }
  return true;
}

export function matchesLocalThread(thread: ThreadSummary, query: string): boolean {
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

export function parsePushData(data: Record<string, unknown> | undefined): {
  accountId?: string;
  folder: string;
  uid?: number;
} {
  const folder =
    typeof data?.mailbox === 'string' && data.mailbox.trim() ? data.mailbox : 'INBOX';
  const accountId = typeof data?.accountId === 'string' ? data.accountId : undefined;
  const rawUid = data?.uid;
  let uid: number | undefined;
  if (typeof rawUid === 'number' && Number.isFinite(rawUid)) uid = rawUid;
  else if (typeof rawUid === 'string' && /^\d+$/.test(rawUid)) uid = Number(rawUid);
  return { accountId, folder, uid };
}

export function isInQuietHours(
  now: Date,
  start: string,
  end: string,
  timeZone?: string
): boolean {
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin == null || endMin == null || startMin === endMin) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || undefined,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const cur = hour * 60 + minute;
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

function parseHHMM(s: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec((s || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface MailHostDefaults {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  allowInsecureTls: boolean;
}

export const KNOWN_MAIL_DOMAINS: Record<
  string,
  { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; allowInsecure?: boolean }
> = {
  'gmail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587 },
  'googlemail.com': { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587 },
  'outlook.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'live.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'office365.com': { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  'yahoo.com': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587 },
  'yahoo.com.hk': { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 587 },
  'icloud.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'me.com': { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  'fastmail.com': { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 587 },
  'qq.com': { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 587 },
  '163.com': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
};

export function applyEmailHostHints(
  email: string,
  current: MailHostDefaults,
  serverDefaults: MailHostDefaults | null
): MailHostDefaults {
  const atIndex = email.lastIndexOf('@');
  if (atIndex <= 0 || atIndex >= email.length - 1) return current;
  const domain = email.slice(atIndex + 1).toLowerCase().trim();
  const known = KNOWN_MAIL_DOMAINS[domain];
  if (known) {
    return {
      imapHost: known.imapHost,
      imapPort: known.imapPort,
      smtpHost: known.smtpHost,
      smtpPort: known.smtpPort,
      allowInsecureTls: known.allowInsecure ?? false,
    };
  }
  if (domain.includes('.')) {
    return {
      ...current,
      imapHost: serverDefaults?.imapHost || current.imapHost || domain,
      smtpHost: serverDefaults?.smtpHost || current.smtpHost || domain,
    };
  }
  return current;
}

export function completeLoginEmail(email: string, imapHost: string): string {
  const trimmed = email.trim();
  if (!trimmed) return trimmed;
  if (trimmed.includes('@')) return trimmed;
  return imapHost ? `${trimmed}@${imapHost}` : trimmed;
}

export function resolveLoginHosts(
  email: string,
  hosts: MailHostDefaults
): { email: string; imapHost: string; smtpHost: string } | { error: 'need-email' | 'need-server' } {
  if (!email.trim()) return { error: 'need-email' };
  let imapHost = hosts.imapHost.trim();
  let smtpHost = hosts.smtpHost.trim();
  const atIndex = email.lastIndexOf('@');
  if ((!imapHost || !smtpHost) && atIndex > 0) {
    const domain = email.slice(atIndex + 1).trim();
    imapHost = imapHost || domain;
    smtpHost = smtpHost || domain;
  }
  if (!imapHost || !smtpHost) return { error: 'need-server' };
  return { email: completeLoginEmail(email, imapHost), imapHost, smtpHost };
}

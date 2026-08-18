export interface EmailAddress {
  name: string;
  address: string;
}

export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string;
  isInline: boolean;
}

export interface MessageSummary {
  uid: number;
  messageId: string;
  subject: string;
  date: string;
  from: EmailAddress[];
  to: EmailAddress[];
  flags: string[];
  unread: boolean;
  starred: boolean;
  hasAttachment: boolean;
  size: number;
  snippet?: string;
}

export interface ParsedMessage {
  uid: number;
  messageId: string;
  subject: string;
  date: string;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress[];
  flags: string[];
  unread: boolean;
  starred: boolean;
  answered: boolean;
  textBody: string;
  htmlBody: string;
  attachments: AttachmentInfo[];
  size: number;
}

export interface FolderInfo {
  name: string;
  delimiter: string;
  attributes: string[];
  totalCount: number;
  unreadCount: number;
  specialUse?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | string;
}

export interface MessageListResult {
  folder: string;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  messages: MessageSummary[];
}

export interface Session {
  id: string;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapUseTls: boolean;
  imapAllowInsecureTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUseTls: boolean;
  smtpAllowInsecureTls: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface LoginRequest {
  email: string;
  username?: string;
  password: string;
  imapHost: string;
  imapPort?: number;
  imapUseTls?: boolean;
  imapAllowInsecureTls?: boolean;
  smtpHost: string;
  smtpPort?: number;
  smtpUseTls?: boolean;
  smtpAllowInsecureTls?: boolean;
}

export interface LoginResponse {
  token: string;
  session: Session;
}

export interface OutgoingMessage {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  inReplyTo?: string;
  references?: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: File[];
}

export interface MailboxEvent {
  type: 'NEW_MESSAGE' | 'EXPUNGE' | 'FLAG_UPDATE' | 'HEARTBEAT' | string;
  mailbox: string;
  totalCount?: number;
  timestamp: string;
}

export interface StandardResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

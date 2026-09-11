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
  threadId?: string;
  folder?: string;
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
  subscribed: boolean;
}

export interface MessageListResult {
  folder: string;
  mode?: 'messages' | 'threads';
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  messages: MessageSummary[];
  threads?: ThreadSummary[];
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  date: string;
  senders: string[];
  messageCount: number;
  unreadCount: number;
  starred: boolean;
  hasAttachment: boolean;
  messages: MessageSummary[];
}

export interface ThreadListResult {
  folder: string;
  mode: 'threads';
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  threads: ThreadSummary[];
}

export interface Account {
  id: string;
  label: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapUseTls: boolean;
  imapAllowInsecureTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUseTls: boolean;
  smtpAllowInsecureTls: boolean;
  sieveHost: string;
  sievePort: number;
  sieveUseTls: boolean;
  sieveAllowInsecureTls: boolean;
  username: string;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  email: string;
  username: string;
  accounts: Account[];
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
  token?: string;
  session?: Session;
  requires2fa?: boolean;
  challenge?: string;
}

export interface Verify2FARequest {
  challenge: string;
  code: string;
}

export interface TwoFAStatusResponse {
  enabled: boolean;
}

export interface TwoFASetupResponse {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  account: string;
}

export interface TwoFAEnableResponse {
  enabled: boolean;
  backupCodes: string[];
}

export interface TwoFARegenerateResponse {
  backupCodes: string[];
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
  /** Web: `Blob`/`File`. Native: `{ uri, name, type }` for React Native FormData. */
  attachments?: MailAttachment[];
}

export type MailAttachment =
  | Blob
  | {
      uri: string;
      name: string;
      type: string;
    };

export interface MailboxEvent {
  type: 'NEW_MESSAGE' | 'EXPUNGE' | 'FLAG_UPDATE' | 'HEARTBEAT' | string;
  sessionId?: string;
  accountId?: string;
  mailbox: string;
  uid?: number;
  totalCount?: number;
  timestamp: string;
}

export interface PushDeviceInfo {
  platform: 'ios' | 'android' | 'web' | string;
  accountIds?: string[];
  timezone?: string;
  createdAt: string;
}

export interface PushRegisterRequest {
  token: string;
  platform: 'ios' | 'android' | 'web';
  accountIds?: string[];
  timezone?: string;
}

export interface StandardResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

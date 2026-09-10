import { describe, expect, it } from 'vitest';
import { matchesLocalQuery } from './localSearch';
import type { MessageSummary } from '../types/api';

const msg = (partial: Partial<MessageSummary>): MessageSummary => ({
  uid: 1,
  messageId: '1',
  subject: 'Hello',
  date: '',
  from: [{ name: 'Ada', address: 'ada@example.com' }],
  to: [{ name: 'Bob', address: 'bob@example.com' }],
  flags: [],
  unread: true,
  starred: false,
  hasAttachment: false,
  size: 0,
  snippet: 'world',
  ...partial,
});

describe('matchesLocalQuery', () => {
  it('matches plain AND tokens against subject/from/snippet', () => {
    expect(matchesLocalQuery(msg({}), 'Hello world')).toBe(true);
    expect(matchesLocalQuery(msg({}), 'Hello missing')).toBe(false);
  });

  it('supports from: and is:unread', () => {
    expect(matchesLocalQuery(msg({}), 'from:ada')).toBe(true);
    expect(matchesLocalQuery(msg({ unread: false }), 'is:unread')).toBe(false);
  });
});

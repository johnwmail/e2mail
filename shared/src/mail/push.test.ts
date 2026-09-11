import { describe, expect, it } from 'vitest';
import { isInQuietHours, parsePushData } from './push';

describe('parsePushData', () => {
  it('defaults folder to INBOX', () => {
    expect(parsePushData(undefined)).toEqual({ folder: 'INBOX' });
  });

  it('parses uid from string', () => {
    expect(parsePushData({ mailbox: 'INBOX', accountId: 'a', uid: '12' })).toEqual({
      accountId: 'a',
      folder: 'INBOX',
      uid: 12,
    });
  });
});

describe('isInQuietHours', () => {
  it('treats empty window as not quiet', () => {
    expect(isInQuietHours(new Date(), '', '')).toBe(false);
  });
});

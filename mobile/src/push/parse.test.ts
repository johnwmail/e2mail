import { parsePushData } from '@e2mail/shared';

describe('parsePushData', () => {
  it('opens inbox without uid', () => {
    expect(parsePushData({ accountId: 'x', mailbox: 'INBOX' })).toEqual({
      accountId: 'x',
      folder: 'INBOX',
    });
  });
});

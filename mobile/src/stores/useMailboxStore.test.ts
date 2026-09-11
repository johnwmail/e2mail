import { isVisibleFolder, sortFolders } from './useMailboxStore';

describe('sortFolders', () => {
  it('orders by saved names then the rest', () => {
    const folders = [
      { name: 'INBOX', delimiter: '/', attributes: [], totalCount: 0, unreadCount: 0, subscribed: true },
      { name: 'Archive', delimiter: '/', attributes: [], totalCount: 0, unreadCount: 0, subscribed: true },
      { name: 'Sent', delimiter: '/', attributes: [], totalCount: 0, unreadCount: 0, subscribed: true },
    ];
    expect(sortFolders(folders, ['Sent', 'INBOX']).map((f) => f.name)).toEqual([
      'Sent',
      'INBOX',
      'Archive',
    ]);
  });
});

describe('isVisibleFolder', () => {
  it('always shows INBOX', () => {
    expect(
      isVisibleFolder(
        {
          name: 'INBOX',
          delimiter: '/',
          attributes: [],
          totalCount: 0,
          unreadCount: 0,
          specialUse: 'inbox',
          subscribed: true,
        },
        { INBOX: false }
      )
    ).toBe(true);
  });

  it('hides folders explicitly marked false', () => {
    expect(
      isVisibleFolder(
        {
          name: 'Lists',
          delimiter: '/',
          attributes: [],
          totalCount: 0,
          unreadCount: 0,
          subscribed: true,
        },
        { Lists: false }
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryStore, joinUrl } from './platform';

describe('joinUrl', () => {
  it('joins a base origin with a rooted path', () => {
    expect(joinUrl('https://mail.example.com', '/api/auth/me')).toBe(
      'https://mail.example.com/api/auth/me'
    );
  });

  it('strips trailing slashes on the base and adds a leading slash on the path', () => {
    expect(joinUrl('https://mail.example.com/', 'api/auth/me')).toBe(
      'https://mail.example.com/api/auth/me'
    );
  });

  it('returns absolute http(s) paths unchanged', () => {
    expect(joinUrl('https://mail.example.com', 'https://other.example/x')).toBe(
      'https://other.example/x'
    );
  });
});

describe('createMemoryStore', () => {
  it('round-trips values and removeItem', async () => {
    const store = createMemoryStore({ a: '1' });
    expect(await store.getItem('a')).toBe('1');
    await store.setItem('b', '2');
    expect(await store.getItem('b')).toBe('2');
    await store.removeItem('a');
    expect(await store.getItem('a')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { applyEmailHostHints, completeLoginEmail, resolveLoginHosts } from './knownHosts';

const empty: Parameters<typeof applyEmailHostHints>[1] = {
  imapHost: '',
  imapPort: 993,
  smtpHost: '',
  smtpPort: 587,
  allowInsecureTls: false,
};

describe('applyEmailHostHints', () => {
  it('fills Gmail hosts', () => {
    const next = applyEmailHostHints('ada@gmail.com', empty, null);
    expect(next.imapHost).toBe('imap.gmail.com');
    expect(next.smtpHost).toBe('smtp.gmail.com');
  });
});

describe('resolveLoginHosts', () => {
  it('completes a local-part with the IMAP host', () => {
    const resolved = resolveLoginHosts('ada', {
      imapHost: 'mail.example.com',
      imapPort: 993,
      smtpHost: 'mail.example.com',
      smtpPort: 587,
      allowInsecureTls: false,
    });
    expect(resolved).toEqual({
      email: 'ada@mail.example.com',
      imapHost: 'mail.example.com',
      smtpHost: 'mail.example.com',
    });
  });

  it('asks for hosts when none can be inferred', () => {
    expect(resolveLoginHosts('ada', empty)).toEqual({ error: 'need-server' });
  });
});

describe('completeLoginEmail', () => {
  it('leaves a full address alone', () => {
    expect(completeLoginEmail('a@b.c', 'ignored')).toBe('a@b.c');
  });
});

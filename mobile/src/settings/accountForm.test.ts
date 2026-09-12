import { accountToForm, emptyAccountForm } from './accountForm';

describe('accountForm', () => {
  it('starts with IMAP 993 / SMTP 587', () => {
    const f = emptyAccountForm();
    expect(f.imapPort).toBe(993);
    expect(f.smtpPort).toBe(587);
    expect(f.imapUseTls).toBe(true);
  });

  it('copies an account without sending the password', () => {
    const f = accountToForm({
      id: '1',
      label: 'Work',
      email: 'a@b.c',
      imapHost: 'imap.b.c',
      imapPort: 993,
      imapUseTls: true,
      imapAllowInsecureTls: false,
      smtpHost: 'smtp.b.c',
      smtpPort: 587,
      smtpUseTls: true,
      smtpAllowInsecureTls: false,
      sieveHost: '',
      sievePort: 4190,
      sieveUseTls: true,
      sieveAllowInsecureTls: false,
      username: 'a',
      isDefault: true,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    });
    expect(f.email).toBe('a@b.c');
    expect(f.password).toBe('');
  });
});

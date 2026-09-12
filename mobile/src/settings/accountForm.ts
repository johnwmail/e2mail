import type { Account, AccountInput } from '@e2mail/shared';

export const emptyAccountForm = (): AccountInput => ({
  label: '',
  email: '',
  imapHost: '',
  imapPort: 993,
  imapUseTls: true,
  imapAllowInsecureTls: false,
  smtpHost: '',
  smtpPort: 587,
  smtpUseTls: true,
  smtpAllowInsecureTls: false,
  sieveHost: '',
  sievePort: 4190,
  sieveUseTls: true,
  sieveAllowInsecureTls: false,
  username: '',
  password: '',
});

export function accountToForm(acc: Account): AccountInput {
  return {
    label: acc.label,
    email: acc.email,
    imapHost: acc.imapHost,
    imapPort: acc.imapPort,
    imapUseTls: acc.imapUseTls,
    imapAllowInsecureTls: acc.imapAllowInsecureTls,
    smtpHost: acc.smtpHost,
    smtpPort: acc.smtpPort,
    smtpUseTls: acc.smtpUseTls,
    smtpAllowInsecureTls: acc.smtpAllowInsecureTls,
    sieveHost: acc.sieveHost || '',
    sievePort: acc.sievePort || 4190,
    sieveUseTls: acc.sieveUseTls,
    sieveAllowInsecureTls: acc.sieveAllowInsecureTls,
    username: acc.username,
    password: '',
  };
}

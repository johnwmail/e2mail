import { createAccountsApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

export type { AccountInput } from '@e2mail/shared';
export const accountsApi = createAccountsApi(getBrowserClient());

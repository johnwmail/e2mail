import { createAuthApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

export const authApi = createAuthApi(getBrowserClient());

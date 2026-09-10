import { createTwoFaApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

export const twoFApi = createTwoFaApi(getBrowserClient());

import { createSieveApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

export type { SieveScriptInfo } from '@e2mail/shared';
export const sieveApi = createSieveApi(getBrowserClient());

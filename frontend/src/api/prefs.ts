import { createPrefsApi } from '@e2mail/shared';
import { getBrowserClient } from './client';

export const prefsApi = createPrefsApi(getBrowserClient());

import { createOnboardingApi } from '@e2mail/shared';
import { getBrowserClient } from './client';
import { accountsApi } from './accounts';

export type { OnboardingStatus } from '@e2mail/shared';
export const onboardingApi = createOnboardingApi(getBrowserClient());
export const accountsApiExtra = {
  ensureJunkFolder: accountsApi.ensureJunkFolder,
};

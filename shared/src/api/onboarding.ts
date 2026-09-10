import type { ApiClient } from './client';

export interface OnboardingStatus {
  twoFAEnabled: boolean;
  pgpEnabled: boolean;
  require2FA: boolean;
  requirePGP: boolean;
  completed: boolean;
}

export function createOnboardingApi(client: ApiClient) {
  return {
    status: (): Promise<OnboardingStatus> => client.request('/onboarding/status'),
  };
}

export type OnboardingApi = ReturnType<typeof createOnboardingApi>;

import { request } from './client';

export interface OnboardingStatus {
  twoFAEnabled: boolean;
  pgpEnabled: boolean;
  require2FA: boolean;
  requirePGP: boolean;
  completed: boolean;
}

export const onboardingApi = {
  status: async (): Promise<OnboardingStatus> => {
    return request<OnboardingStatus>('/onboarding/status');
  },
};

export const accountsApiExtra = {
  ensureJunkFolder: async (accountId: string): Promise<{ junkFolder: string }> => {
    return request<{ junkFolder: string }>(`/accounts/${accountId}/ensure-junk-folder`, {
      method: 'POST',
    });
  },
};

import type { ApiClient } from './client';
import type {
  LoginRequest,
  LoginResponse,
  Session,
  Verify2FARequest,
} from '../types/api';

/** Auth endpoints. See `backend/internal/api/router.go` for the route table. */
export function createAuthApi(client: ApiClient) {
  return {
    login: (req: LoginRequest): Promise<LoginResponse> =>
      client.request<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(req),
      }),

    verify2fa: (req: Verify2FARequest): Promise<LoginResponse> =>
      client.request<LoginResponse>('/auth/verify-2fa', {
        method: 'POST',
        body: JSON.stringify(req),
      }),

    logout: (): Promise<void> =>
      client.request<void>('/auth/logout', { method: 'POST' }),

    getMe: (): Promise<Session> => client.request<Session>('/auth/me'),

    changePassword: (
      oldPassword: string,
      newPassword: string,
      confirmPassword: string,
      account?: string
    ): Promise<{ changed: boolean }> =>
      client.request<{ changed: boolean }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          oldPassword,
          newPassword,
          confirmPassword,
          ...(account ? { account } : {}),
        }),
      }),
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;

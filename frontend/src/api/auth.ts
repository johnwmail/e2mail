import { request } from './client';
import { LoginRequest, LoginResponse, Session, Verify2FARequest } from '../types/api';

export const authApi = {
  login: async (req: LoginRequest): Promise<LoginResponse> => {
    return request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  verify2fa: async (req: Verify2FARequest): Promise<LoginResponse> => {
    return request<LoginResponse>('/auth/verify-2fa', {
      method: 'POST',
      body: JSON.stringify(req),
    });
  },

  logout: async (): Promise<void> => {
    return request<void>('/auth/logout', {
      method: 'POST',
    });
  },

  getMe: async (): Promise<Session> => {
    return request<Session>('/auth/me');
  },

  changePassword: async (oldPassword: string, newPassword: string, confirmPassword: string): Promise<{ changed: boolean }> => {
    return request<{ changed: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword, confirmPassword }),
    });
  },
};

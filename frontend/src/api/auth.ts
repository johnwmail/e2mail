import { request } from './client';
import { LoginRequest, LoginResponse, Session } from '../types/api';

export const authApi = {
  login: async (req: LoginRequest): Promise<LoginResponse> => {
    return request<LoginResponse>('/auth/login', {
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
};

import { RoleEnum } from "../enums/role.enum";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: RoleEnum | string;
  roleDisplayName?: string;
  profileId?: string;
  institutionId?: string;
  campusId?: string;
}

export interface UserSessionPayload {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  user: AuthenticatedUser;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

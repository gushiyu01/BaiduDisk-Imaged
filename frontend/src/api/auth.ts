import http from './client'
import type { AuthUser, LoginRequest } from '../types'

/** POST /api/auth/login（免登录，成功即下发 HttpOnly Cookie） */
export async function login(payload: LoginRequest): Promise<AuthUser> {
  const res = await http.post<AuthUser>('/auth/login', payload)
  return res.data
}

/** POST /api/auth/logout → 204 */
export async function logout(): Promise<void> {
  await http.post('/auth/logout')
}

/** GET /api/auth/me */
export async function me(): Promise<AuthUser> {
  const res = await http.get<AuthUser>('/auth/me')
  return res.data
}

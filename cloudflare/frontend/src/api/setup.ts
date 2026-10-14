import http from './client'
import type { SetupInitRequest, SetupInitResponse, SetupStatus } from '../types'

/** GET /api/setup/status（免登录） */
export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await http.get<SetupStatus>('/setup/status')
  return res.data
}

/** POST /api/setup/init（免登录，仅首次可用；409 = 已初始化） */
export async function initSetup(payload: SetupInitRequest): Promise<SetupInitResponse> {
  const res = await http.post<SetupInitResponse>('/setup/init', payload)
  return res.data
}

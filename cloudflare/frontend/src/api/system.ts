import http from './client'
import type { SystemInfo } from '../types'

/** GET /api/system/info */
export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await http.get<SystemInfo>('/system/info')
  return res.data
}

/** POST /api/system/cache/clear → 204 */
export async function clearCache(): Promise<void> {
  await http.post('/system/cache/clear')
}

import http from './client'
import type {
  AuthorizeUrlResponse,
  BaiduStatus,
  BaiduTokenRequest,
  BrowseResult,
  DiagnoseResult
} from '../types'

/** GET /api/baidu/status */
export async function getBaiduStatus(): Promise<BaiduStatus> {
  const res = await http.get<BaiduStatus>('/baidu/status')
  return res.data
}

/** GET /api/baidu/authorize-url → 前端 window.open(url) */
export async function getAuthorizeUrl(): Promise<AuthorizeUrlResponse> {
  const res = await http.get<AuthorizeUrlResponse>('/baidu/authorize-url')
  return res.data
}

/** POST /api/baidu/token（用授权码换 token） */
export async function submitToken(payload: BaiduTokenRequest): Promise<BaiduStatus> {
  const res = await http.post<BaiduStatus>('/baidu/token', payload)
  return res.data
}

/** POST /api/baidu/refresh */
export async function refreshToken(): Promise<BaiduStatus> {
  const res = await http.post<BaiduStatus>('/baidu/refresh')
  return res.data
}

/** POST /api/baidu/disconnect → 204 */
export async function disconnect(): Promise<void> {
  await http.post('/baidu/disconnect')
}

/** POST /api/baidu/diagnose（后端逐项真实体检，前端只渲染返回值） */
export async function diagnose(): Promise<DiagnoseResult> {
  const res = await http.post<DiagnoseResult>('/baidu/diagnose')
  return res.data
}

/** GET /api/baidu/browse?dir=/ */
export async function browse(dir: string): Promise<BrowseResult> {
  const res = await http.get<BrowseResult>('/baidu/browse', { params: { dir } })
  return res.data
}

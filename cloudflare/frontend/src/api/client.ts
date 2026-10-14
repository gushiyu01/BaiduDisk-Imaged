import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios'
import type { ApiErrorBody } from '../types'

/** 统一的 API 异常，携带后端返回的 error code 与中文 message */
export class ApiRequestError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

/** 把任意异常规整成 ApiRequestError，方便 UI 统一取 message / code */
export function toApiRequestError(err: unknown): ApiRequestError {
  if (err instanceof ApiRequestError) return err
  if (err instanceof Error) return new ApiRequestError('UNKNOWN', err.message)
  return new ApiRequestError('UNKNOWN', '未知错误')
}

/** 取可展示的中文错误信息 */
export function getErrorMessage(err: unknown): string {
  return toApiRequestError(err).message
}

/** 取后端错误码（如 TOKEN_EXPIRED / NOT_FOUND / BAD_CREDENTIALS） */
export function getErrorCode(err: unknown): string {
  return toApiRequestError(err).code
}

function isAuthPage(): boolean {
  const path = window.location.pathname
  return path === '/login' || path === '/setup'
}

/** 401 时跳登录页（已在 /login 或 /setup 时不动，避免死循环） */
function redirectToLogin(): void {
  if (isAuthPage()) return
  const from = window.location.pathname + window.location.search
  const target = `/login?redirect=${encodeURIComponent(from)}`
  window.location.replace(target)
}

/** 数组参数序列化为可重复查询参数：tag=1&tag=2（而不是 tag[]=1） */
function serializeParams(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue
        search.append(key, String(item))
      }
    } else {
      search.append(key, String(value))
    }
  }
  return search.toString()
}

export const http: AxiosInstance = axios.create({
  baseURL: '/api',
  withCredentials: true,
  timeout: 300000,
  headers: { Accept: 'application/json' },
  // GET /api/images 的 tag 需要作为可重复参数发送
  paramsSerializer: {
    serialize: (params: Record<string, unknown>) => serializeParams(params)
  }
})

http.interceptors.request.use((config: InternalAxiosRequestConfig) => config)

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status
    const body = error.response?.data
    const hasBody = body !== null && typeof body === 'object'

    const code = hasBody && typeof body.error === 'string' && body.error
      ? body.error
      : status
        ? `HTTP_${status}`
        : 'NETWORK_ERROR'

    let message: string
    if (hasBody && typeof body.message === 'string' && body.message) {
      message = body.message
    } else if (error.code === 'ECONNABORTED') {
      message = '请求超时，请稍后重试'
    } else if (!status) {
      message = '无法连接后端服务，请确认后端已启动'
    } else {
      message = `请求失败（HTTP ${status}）`
    }

    if (status === 401) {
      redirectToLogin()
    }

    return Promise.reject(new ApiRequestError(code, message, status))
  }
)

export default http

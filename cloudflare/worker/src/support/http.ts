import { ApiException, BaiduPanException } from './errors'

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

export function apiError(code: string, message: string, status: number): Response {
  return json({ error: code, message }, status)
}

/**
 * 把异常翻译成前端约定的 {error, message}，message 保留真实原因。
 * 与 Java 版 GlobalExceptionHandler 的状态码映射一致。
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof ApiException) {
    return apiError(err.code, err.message, err.status)
  }
  if (err instanceof BaiduPanException) {
    if (err.isAuthFailure) {
      return apiError('TOKEN_EXPIRED', err.message, 503)
    }
    if (err.isQuotaExceeded) {
      return apiError('QUOTA_EXCEEDED', err.message, 507)
    }
    if (err.isNotFound) {
      return apiError('NOT_FOUND', err.message, 404)
    }
    return apiError('UPSTREAM_FAILED', err.message, 502)
  }
  const message = err instanceof Error ? err.message : String(err)
  return apiError('INTERNAL_ERROR', message, 500)
}

/** 统一包裹路由处理器，异常自动转成约定格式 */
export async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof ApiException) && !(err instanceof BaiduPanException)) {
      console.error('未处理的异常', err)
    }
    return toErrorResponse(err)
  }
}

/** 读取 JSON 请求体，空 body 时返回 {} */
export async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text()
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw ApiException.badRequest('请求体不是合法 JSON')
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim())
    }
  }
  return null
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `picman_token=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 文件名可能含中文，Content-Disposition 要按 RFC 5987 用 UTF-8 传，
 * 同时留一个 ASCII 兜底名给老浏览器。
 */
export function contentDisposition(filename: string): string {
  let ascii = ''
  for (const ch of filename) {
    ascii += ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e ? ch : '_'
  }
  ascii = ascii.replace(/"/g, "'").trim() || 'download'
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

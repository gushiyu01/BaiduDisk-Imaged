import type { Env } from '../env'
import { ERRNO } from '../support/errno'
import { BaiduPanException } from '../support/errors'

export interface TokenStatus {
  authorized: boolean
  expiresAt: number | null
  scope: string | null
}

/**
 * Durable Object 的客户端封装。
 * 令牌本身存在 DO 里，Worker 每次要用令牌时通过这里取，不要在本地缓存。
 */
export class BaiduTokenStore {
  constructor(private readonly env: Env) {}

  /** 固定用同一个 DO 实例名，保证全局只有一份令牌状态 */
  private stub(): DurableObjectStub {
    return this.env.TOKEN_DO.get(this.env.TOKEN_DO.idFromName('baidu-token'))
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.stub().fetch(`https://do${path}`, init)
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new BaiduPanException(ERRNO.INVALID_TOKEN, `令牌服务返回非 JSON：${text.slice(0, 200)}`)
    }
    if (!res.ok) {
      const err = body as { errno?: number; message?: string }
      throw new BaiduPanException(err.errno ?? ERRNO.INVALID_TOKEN, err.message ?? '令牌服务调用失败')
    }
    return body as T
  }

  async status(): Promise<TokenStatus> {
    return this.call<TokenStatus>('/status')
  }

  async authorizeUrl(): Promise<string> {
    const r = await this.call<{ url: string }>('/authorize-url')
    return r.url
  }

  async accessToken(): Promise<string> {
    const r = await this.call<{ token: string }>('/access-token', { method: 'POST' })
    return r.token
  }

  async exchangeCode(code: string): Promise<TokenStatus> {
    return this.call<TokenStatus>('/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  }

  async refresh(): Promise<TokenStatus> {
    return this.call<TokenStatus>('/refresh', { method: 'POST' })
  }

  /** 用外部 refresh_token 换取令牌（从自建部署迁移用） */
  async importRefreshToken(refreshToken: string): Promise<TokenStatus> {
    return this.call<TokenStatus>('/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
  }

  async clear(): Promise<void> {
    await this.call<{ ok: boolean }>('/clear', { method: 'POST' })
  }
}

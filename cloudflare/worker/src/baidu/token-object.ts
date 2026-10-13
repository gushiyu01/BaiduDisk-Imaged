import type { Env } from '../env'
import type { TokenResponse } from './dto'
import { ERRNO } from '../support/errno'
import { BaiduPanException } from '../support/errors'

const TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token'
const AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize'

/** 提前多久刷新，避免请求正好卡在过期瞬间 */
const REFRESH_WINDOW_MS = 5 * 60 * 1000

const STORAGE_KEY = 'baidu-token'

export interface StoredToken {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope: string
}

export interface TokenStatus {
  authorized: boolean
  expiresAt: number | null
  scope: string | null
}

/**
 * 百度令牌的唯一持有者。
 *
 * 为什么必须做成 Durable Object：
 * 百度的 refresh_token 是**一次性**的，用掉就作废。Workers 是全球多 isolate 并发、
 * 没有共享锁，两个 isolate 同时刷新会让其中一个拿到已失效的 token，
 * 而刷新失败会让 refresh_token 永久作废、用户必须重新授权。
 * Durable Object 全局单实例，把令牌读写收敛进来就从根上避免了这个问题。
 *
 * 注意：DO 虽然是单线程的，但 `await fetch(...)` 会让出控制权，
 * 所以并发请求依然可能同时走到刷新分支。下面用 refreshing 这个 Promise 做合并，
 * 保证同一时刻只有一个真正的刷新请求在飞。
 */
export class BaiduTokenObject implements DurableObject {
  private refreshing: Promise<string> | null = null

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      switch (`${request.method} ${url.pathname}`) {
        case 'GET /status':
          return Response.json(await this.status())
        case 'GET /authorize-url':
          return Response.json({ url: this.authorizeUrl() })
        case 'POST /access-token':
          return Response.json({ token: await this.accessToken() })
        case 'POST /exchange': {
          const { code } = (await request.json()) as { code?: string }
          await this.exchange(code ?? '')
          return Response.json(await this.status())
        }
        case 'POST /import': {
          // 从自建部署迁移过来时用：只接受 refresh_token，立刻刷一次拿新的 access_token。
          // 不接受直接传 access_token —— 那样无法验证令牌是否真的有效。
          const { refreshToken } = (await request.json()) as { refreshToken?: string }
          await this.importRefreshToken(refreshToken ?? '')
          return Response.json(await this.status())
        }
        case 'POST /refresh': {
          await this.accessToken(true)
          return Response.json(await this.status())
        }
        case 'POST /clear':
          await this.state.storage.delete(STORAGE_KEY)
          return Response.json({ ok: true })
        default:
          return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
      }
    } catch (err) {
      // 统一用 { ok:false, errno, message } 回给调用方，由 token-store 还原成异常
      const message = err instanceof Error ? err.message : String(err)
      const errno = err instanceof BaiduPanException ? err.errno : ERRNO.INVALID_TOKEN
      return Response.json({ ok: false, errno, message }, { status: 400 })
    }
  }

  // ------------------------------------------------------------------ 授权流程

  private authorizeUrl(): string {
    this.requireConfigured()
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.env.BAIDU_DISK_APP_KEY,
      redirect_uri: 'oob',
      scope: 'basic,netdisk',
      display: 'page',
    })
    return `${AUTHORIZE_URL}?${q}`
  }

  private async exchange(code: string): Promise<void> {
    this.requireConfigured()
    if (!code.trim()) {
      throw new BaiduPanException(ERRNO.INVALID_TOKEN, '授权码不能为空')
    }
    const resp = await this.postToken({
      grant_type: 'authorization_code',
      code: code.trim(),
      client_id: this.env.BAIDU_DISK_APP_KEY,
      client_secret: this.env.BAIDU_DISK_SECRET_KEY,
      redirect_uri: 'oob',
    })
    await this.persist(resp)
  }

  // ------------------------------------------------------------------ 迁移

  /**
   * 用外部传入的 refresh_token 换取令牌。
   *
   * 注意：百度的 refresh_token 是一次性的，这里用掉之后**原来那份就作废了**。
   * 所以这个动作等价于「把授权从旧部署搬到本部署」，老部署之后需要重新授权。
   */
  private async importRefreshToken(refreshToken: string): Promise<void> {
    this.requireConfigured()
    const rt = refreshToken.trim()
    if (!rt) throw new BaiduPanException(ERRNO.INVALID_TOKEN, 'refresh_token 不能为空')
    await this.state.storage.put<StoredToken>(STORAGE_KEY, {
      accessToken: '',
      refreshToken: rt,
      // 置零确保接下来一定走刷新流程
      expiresAt: 0,
      scope: '',
    })
    await this.doRefresh({
      accessToken: '',
      refreshToken: rt,
      expiresAt: 0,
      scope: '',
    })
  }

  // ------------------------------------------------------------------ 取用令牌

  async status(): Promise<TokenStatus> {
    const rec = await this.state.storage.get<StoredToken>(STORAGE_KEY)
    if (!rec) return { authorized: false, expiresAt: null, scope: null }
    return { authorized: true, expiresAt: rec.expiresAt, scope: rec.scope }
  }

  /** 取一个当前有效的 access_token，必要时刷新 */
  async accessToken(force = false): Promise<string> {
    const rec = await this.state.storage.get<StoredToken>(STORAGE_KEY)
    if (!rec) {
      throw new BaiduPanException(ERRNO.INVALID_TOKEN, '尚未完成百度网盘授权，请先授权')
    }
    if (!force && rec.expiresAt - Date.now() > REFRESH_WINDOW_MS) {
      return rec.accessToken
    }
    // 合并并发刷新：同一时刻只允许一个真正的刷新请求
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(rec).finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(rec: StoredToken): Promise<string> {
    this.requireConfigured()
    const resp = await this.postToken({
      grant_type: 'refresh_token',
      refresh_token: rec.refreshToken,
      client_id: this.env.BAIDU_DISK_APP_KEY,
      client_secret: this.env.BAIDU_DISK_SECRET_KEY,
    })

    if (resp.error) {
      // refresh_token 一旦刷新失败就永久作废，只能重新授权，这里必须清干净
      await this.state.storage.delete(STORAGE_KEY)
      throw new BaiduPanException(
        ERRNO.INVALID_TOKEN,
        `百度网盘授权已失效（${resp.error}），请重新授权`,
      )
    }
    await this.persist(resp)
    return resp.access_token as string
  }

  // ------------------------------------------------------------------ 工具

  private async postToken(params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams(params)
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    const text = await res.text()
    if (!text.trim()) {
      throw new BaiduPanException(ERRNO.INVALID_TOKEN, `百度令牌接口返回空响应（HTTP ${res.status}）`)
    }
    try {
      return JSON.parse(text) as TokenResponse
    } catch {
      throw new BaiduPanException(ERRNO.INVALID_TOKEN, `百度令牌接口返回非 JSON：${text.slice(0, 200)}`)
    }
  }

  private async persist(resp: TokenResponse): Promise<void> {
    if (!resp.access_token) {
      throw new BaiduPanException(
        ERRNO.INVALID_TOKEN,
        `百度未返回 access_token：${resp.error_description ?? resp.error ?? '未知原因'}`,
      )
    }
    const existing = await this.state.storage.get<StoredToken>(STORAGE_KEY)
    const expiresIn = typeof resp.expires_in === 'number' && resp.expires_in > 0 ? resp.expires_in : 2592000
    const next: StoredToken = {
      accessToken: resp.access_token,
      // 刷新响应一定会带新的 refresh_token；万一没带就沿用旧的
      refreshToken: resp.refresh_token || existing?.refreshToken || '',
      expiresAt: Date.now() + expiresIn * 1000,
      scope: resp.scope || existing?.scope || 'basic netdisk',
    }
    await this.state.storage.put(STORAGE_KEY, next)
  }

  private requireConfigured(): void {
    if (!this.env.BAIDU_DISK_APP_KEY?.trim() || !this.env.BAIDU_DISK_SECRET_KEY?.trim()) {
      throw new BaiduPanException(
        ERRNO.INVALID_TOKEN,
        '后端未配置百度网盘应用凭证，请设置 secret BAIDU_DISK_APP_KEY 与 BAIDU_DISK_SECRET_KEY',
      )
    }
  }
}

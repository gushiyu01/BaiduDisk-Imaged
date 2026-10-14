/** Worker 的绑定与变量。密钥只在 secret 里，不落 wrangler.toml。 */
export interface Env {
  /** D1 数据库 */
  DB: D1Database
  /** KV：缩略图缓存（R2 需在控制台单独开通，这个账户还没开） */
  CACHE: KVNamespace
  /** 百度令牌的串行化入口 */
  TOKEN_DO: DurableObjectNamespace
  /** 前端构建产物 */
  ASSETS: Fetcher

  /** 百度开放平台凭证，来自 `wrangler secret put` */
  BAIDU_DISK_APP_KEY: string
  BAIDU_DISK_SECRET_KEY: string
  BAIDU_DISK_APP_ID?: string

  /** 图库在网盘上的根目录 */
  BAIDU_BASE_DIR: string
  /** 登录有效期（小时） */
  PICMAN_SESSION_HOURS: string
}

export function sessionHours(env: Env): number {
  const n = Number.parseInt(env.PICMAN_SESSION_HOURS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 168
}

export function baseDir(env: Env): string {
  const raw = (env.BAIDU_BASE_DIR || '/apps/picman').trim()
  return raw.length > 1 && raw.endsWith('/') ? raw.replace(/\/+$/, '') : raw
}

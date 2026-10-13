/**
 * 会话令牌（HS256 JWT）。
 *
 * 用 Web Crypto 手写而不是引 jose：只需要签发和验签两个动作，
 * 少一个依赖就少一份供应链暴露面，而且 Workers 的 crypto.subtle 原生支持 HMAC。
 *
 * 签名密钥不从环境变量读，而是首次启动时随机生成写进 D1 的 system_config ——
 * 这样部署时不用额外准备一个 secret，重启也不会让已登录用户掉线。
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export const CONFIG_KEY = 'picman.jwt_secret'

export interface SessionPayload {
  sub: string
  exp: number
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(input: string): Uint8Array {
  const s = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  // 先 SHA-256 派生定长密钥，这样使用者配多短的字符串都不会因为 HS256 要求 256 位而报错
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signJwt(subject: string, secret: string, ttlSeconds: number): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const body = b64urlEncode(enc.encode(JSON.stringify({ sub: subject, exp })))
  const data = `${header}.${body}`
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))
  return `${data}.${b64urlEncode(sig)}`
}

/** 校验签名与有效期，失败返回 null（不抛异常，过滤器里到处 try/catch 更难看） */
export async function verifyJwt(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  try {
    const key = await hmacKey(secret)
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig) as BufferSource,
      enc.encode(`${header}.${body}`),
    )
    if (!ok) return null
    const payload = JSON.parse(dec.decode(b64urlDecode(body))) as SessionPayload
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    if (typeof payload.sub !== 'string' || !payload.sub) return null
    return payload
  } catch {
    return null
  }
}

/**
 * 取会话签名密钥，没有就生成一个写进 D1 并读回。
 *
 * 为什么读回而不是直接用生成的值：并发冷启动时两个 isolate 可能同时发现
 * 「没有密钥」并各自生成，后写入的会把先写入的覆盖掉。读回能保证两个 isolate
 * 最终用同一个值，否则会出现「刚登录就掉线」。这种竞态窗口只存在于首次启动。
 */
export async function loadOrCreateJwtSecret(repo: {
  getConfig(key: string): Promise<string | null>
  putConfig(key: string, value: string): Promise<void>
}): Promise<string> {
  const existing = await repo.getConfig(CONFIG_KEY)
  if (existing) return existing

  const random = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (let i = 0; i < random.length; i++) s += String.fromCharCode(random[i])

  await repo.putConfig(CONFIG_KEY, btoa(s))
  return (await repo.getConfig(CONFIG_KEY)) ?? btoa(s)
}

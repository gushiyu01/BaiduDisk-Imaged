/**
 * 密码哈希（PBKDF2-SHA256）。
 *
 * 为什么不用 BCrypt：Workers 运行时没有 BCrypt，而 Java 版用的就是 BCrypt，
 * 两边哈希不通用 —— 所以 Cloudflare 版是独立部署、独立账号，不共享用户表。
 *
 * 迭代次数取 100000：实测探针里这个量级在 Free 套餐上完全跑得动（CPU 消耗可忽略），
 * 同时远高于「能被暴力破解」的下限。
 */
const ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256

const enc = new TextEncoder()

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const bits = await derive(password, salt, ITERATIONS)
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(bits)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number.parseInt(parts[1], 10)
  if (!Number.isFinite(iterations) || iterations <= 0) return false
  const salt = fromBase64(parts[2])
  const expected = fromBase64(parts[3])
  const actual = await derive(password, salt, iterations)
  return timingSafeEqual(actual, expected)
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

/** 定长比较，避免通过响应时间差推断哈希前缀 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

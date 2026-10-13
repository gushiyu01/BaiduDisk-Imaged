import { BaiduPanException } from '../support/errors'

/**
 * dlink / 缩略图地址的主机校验，防 SSRF。
 *
 * 百度返回的下载地址会跳到 CDN，主机名不固定，所以用后缀白名单而不是硬编码单台主机。
 * 重定向链上的每一跳都要过这里，只校验第一跳会被 302 绕到内网地址。
 */
const DEFAULT_ALLOWED_SUFFIXES = [
  'baidupcs.com',
  'baidu.com',
  'baidubce.com',
  'bdstatic.com',
  'pcs.baidu.com',
]

const ALLOWED_SUFFIXES = DEFAULT_ALLOWED_SUFFIXES

export function isAllowedDlink(url: string | null | undefined): boolean {
  if (!url || !url.trim()) return false
  let parsed: URL
  try {
    parsed = new URL(url.trim())
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  const host = parsed.hostname.toLowerCase()
  if (!host) return false
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export function assertAllowedDlink(url: string, what: string): void {
  if (!isAllowedDlink(url)) {
    let host = '(无法解析)'
    try {
      host = new URL(url).hostname
    } catch {
      // 保持占位
    }
    throw new BaiduPanException(
      Number.MIN_SAFE_INTEGER,
      `拒绝访问${what}：主机 ${host} 不在白名单内`,
    )
  }
}

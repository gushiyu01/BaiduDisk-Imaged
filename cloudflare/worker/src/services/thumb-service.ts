import type { Env } from '../env'
import type { Repo, AssetRow } from '../db/repo'
import type { BaiduPanClient } from '../baidu/client'
import { bestThumbUrl } from '../baidu/dto'
import { detectImageMime, OCTET_STREAM } from '../support/mime'
import { ApiException, BaiduPanException } from '../support/errors'
import { ERRNO } from '../support/errno'

/**
 * 缩略图。
 *
 * 与 Java 版的**关键差异**：Worker 里没有 ImageIO，无法本地生成缩略图。
 * 所以只有两条路：
 *   1. 百度官方缩略图（filemetas 带 thumb=1）—— 绝大多数图片都有，直接缓存进 KV
 *   2. 官方图不可用时，把原图当作缩略图返回，让浏览器自己缩放
 *
 * 第 2 条对几 MB 以内的图完全够用；更大的会在下面直接拒绝并说明原因，
 * 而不是让用户白等一次几十 MB 的下载。想要真正的本地缩放，出路是上 Workers Paid
 * 再用 WASM 解码器，或者把这个接口代理回自建后端。
 */
const MAX_ORIGINAL_FALLBACK_BYTES = 10 * 1024 * 1024
/** 超过这个大小就不进 KV 缓存：KV 单值上限 25MB，而且没必要为一次浏览占住额度 */
const MAX_CACHE_BYTES = 2 * 1024 * 1024
const KV_TTL_SECONDS = 30 * 24 * 3600

export interface ThumbResult {
  data: Uint8Array
  source: string
  contentType: string
}

/**
 * 缓存键带上 md5/修改时间做版本号，网盘上的文件变了缓存自然失效。
 * KV 的 key 不能有奇怪字符，所以把版本号过滤一下。
 */
function cacheKey(row: AssetRow): string {
  const version = (row.md5 || row.server_mtime || 'v0').replace(/[^A-Za-z0-9]/g, '')
  return `thumb:${row.id}:${version}`
}

export async function getThumbnail(
  env: Env,
  repo: Repo,
  baidu: BaiduPanClient,
  row: AssetRow,
): Promise<ThumbResult> {
  const key = cacheKey(row)

  const cached = await env.CACHE.get(key, 'arrayBuffer')
  if (cached) {
    const data = new Uint8Array(cached)
    return { data, source: row.thumb_source, contentType: detectImageMime(data) }
  }

  const meta = await resolveMeta(baidu, row)

  // 1) 官方缩略图
  const thumbUrl = meta ? bestThumbUrl(meta.thumbs) : null
  if (thumbUrl) {
    const data = await baidu.fetchThumb(thumbUrl)
    if (data.length > 0) {
      await env.CACHE.put(key, data, { expirationTtl: KV_TTL_SECONDS })
      await repo.updateThumbSource(row.id, 'BAIDU')
      return { data, source: 'BAIDU', contentType: detectImageMime(data) }
    }
  }

  // 2) 官方图不可用 → 原图兜底
  if (!meta?.dlink) {
    await repo.updateThumbSource(row.id, 'NONE')
    throw new BaiduPanException(
      ERRNO.NOT_FOUND,
      '无法获取缩略图：百度未返回缩略图，也拿不到下载地址（文件可能已被移动或删除）',
    )
  }
  const size = meta.size ?? row.size
  if (size > MAX_ORIGINAL_FALLBACK_BYTES) {
    await repo.updateThumbSource(row.id, 'NONE')
    throw new ApiException(
      502,
      'THUMB_UNAVAILABLE',
      `无法生成缩略图：原图 ${(size / 1048576).toFixed(1)}MB 超过 ${MAX_ORIGINAL_FALLBACK_BYTES / 1048576}MB 兜底上限，` +
        '且百度未提供官方缩略图。Cloudflare 版没有本地图片处理能力，点开原图仍可正常查看。',
    )
  }

  const stream = await baidu.openDlink(meta.dlink, null)
  const data = new Uint8Array(await new Response(stream.body).arrayBuffer())
  if (data.length <= MAX_CACHE_BYTES) {
    await env.CACHE.put(key, data, { expirationTtl: KV_TTL_SECONDS })
  }
  await repo.updateThumbSource(row.id, 'ORIGINAL')
  const contentType = detectImageMime(data)
  return {
    data,
    source: 'ORIGINAL',
    contentType: contentType === OCTET_STREAM ? 'image/jpeg' : contentType,
  }
}

/**
 * fs_id 可能因为重命名而失效，所以失败时按路径再查一次。
 * 顺带把百度不保证返回的宽高补进库（实测 extra=1 时有时无）。
 */
async function resolveMeta(baidu: BaiduPanClient, row: AssetRow) {
  if (row.fs_id) {
    const id = Number.parseInt(row.fs_id, 10)
    if (Number.isFinite(id)) {
      try {
        const meta = await baidu.fileMeta(id)
        if (meta?.fs_id) return meta
      } catch {
        // 落到按路径查
      }
    }
  }
  return baidu.metaByPath(row.path, { dlink: true, thumb: true })
}

export async function clearThumbCache(env: Env): Promise<number> {
  let removed = 0
  let cursor: string | undefined
  do {
    const page = await env.CACHE.list({ prefix: 'thumb:', cursor })
    await Promise.all(page.keys.map((k) => env.CACHE.delete(k.name)))
    removed += page.keys.length
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return removed
}

import { ApiException } from '../support/errors'
import { extensionOf, hasThumbnail, isValidKind, kindOf, type AssetKind } from '../support/kinds'
import { mimeFromFilename } from '../support/mime'
import type { AssetQuery, AssetRow, Repo, TagRow } from '../db/repo'

/** 与 docs/API.md 的 AssetDto 一一对应，前端不用改 */
export interface AssetDto {
  id: number
  fsId: string | null
  name: string
  path: string
  size: number
  kind: AssetKind
  category: number | null
  width: number | null
  height: number | null
  mime: string
  ext: string
  md5: string | null
  serverMtime: string | null
  favorite: boolean
  tags: Array<{ id: number; name: string; color: string }>
  thumbSource: string
  thumbnailable: boolean
  missing: boolean
  indexedAt: string
}

export function tagDto(t: TagRow) {
  return { id: t.id, name: t.name, color: t.color, count: t.cnt ?? undefined }
}

export function toAssetDto(row: AssetRow, tags: TagRow[]): AssetDto {
  const kind = (isValidKind(row.kind) ? row.kind : 'OTHER') as AssetKind
  const ext = extensionOf(row.name)
  return {
    id: row.id,
    fsId: row.fs_id,
    name: row.name,
    path: row.path,
    size: row.size,
    kind,
    category: row.category,
    width: row.width,
    height: row.height,
    mime: row.mime ?? mimeFromFilename(row.name, ext),
    ext,
    md5: row.md5,
    serverMtime: row.server_mtime,
    favorite: row.favorite === 1,
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    thumbSource: row.thumb_source,
    thumbnailable: hasThumbnail(kind),
    missing: row.missing === 1,
    indexedAt: row.indexed_at,
  }
}

/** 文件名里百度不接受的字符，实测报错文案：「命名中包含?|"><:*等特殊字符」 */
const ILLEGAL_PATH_CHARS = /[\\/:*?"<>|]/g
const MAX_NAME_LENGTH = 180

export function sanitizeFilename(name: string): string {
  const base = name.replace(/\\/g, '/')
  const slash = base.lastIndexOf('/')
  const tail = slash >= 0 ? base.slice(slash + 1) : base
  let cleaned = tail.replace(ILLEGAL_PATH_CHARS, '_').trim()
  // 去掉首尾的点和空格：Windows 与百度都不友好
  cleaned = cleaned.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (cleaned.length > MAX_NAME_LENGTH) {
    const ext = extensionOf(cleaned)
    const keep = Math.max(1, MAX_NAME_LENGTH - (ext ? ext.length + 1 : 0))
    const stem = ext ? cleaned.slice(0, cleaned.length - ext.length - 1) : cleaned
    cleaned = stem.slice(0, keep) + (ext ? `.${ext}` : '')
  }
  return cleaned
}

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

export enum DeleteMode {
  INDEX = 'index',
  REMOTE = 'remote',
  BOTH = 'both',
}

export function parseDeleteMode(raw: string | null): DeleteMode {
  switch ((raw ?? 'index').trim().toLowerCase()) {
    case 'remote': return DeleteMode.REMOTE
    case 'both': return DeleteMode.BOTH
    case 'index': return DeleteMode.INDEX
    default:
      throw ApiException.badRequest(`未知的删除模式：${raw}（可选 index / remote / both）`)
  }
}

export function parseKind(raw: string | null): AssetKind | null {
  if (raw === null || !raw.trim()) return null
  const upper = raw.trim().toUpperCase()
  if (!isValidKind(upper)) {
    throw ApiException.badRequest(`未知的文件类型：${raw}`)
  }
  return upper
}

export function buildQuery(url: URL, forcedKind?: AssetKind): AssetQuery {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const sizeRaw = Number.parseInt(url.searchParams.get('size') ?? '24', 10) || 24
  const size = Math.min(Math.max(1, sizeRaw), 100)
  const favorite = url.searchParams.get('favorite')
  const tagIds = url.searchParams
    .getAll('tag')
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isFinite(n))

  return {
    q: url.searchParams.get('q'),
    tagIds,
    favorite: favorite === 'true',
    kind: forcedKind ?? parseKind(url.searchParams.get('kind')),
    sort: url.searchParams.get('sort') ?? 'time_desc',
    page,
    size,
  }
}

/** 从百度条目推导 kind，扩展名优先、category 兜底 */
export function kindFromRemote(category: number | null | undefined, name: string): AssetKind {
  return kindOf(category, name)
}

export type { AssetRow, AssetQuery, Repo }

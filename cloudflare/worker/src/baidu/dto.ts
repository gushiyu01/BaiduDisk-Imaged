/**
 * 百度网盘开放平台的响应类型。
 * 字段以实测响应为准，不是照抄文档 —— 例如分片上传成功时只有 {md5, request_id} 没有 errno。
 */

export interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

export interface UinfoResponse {
  errno: number
  errmsg?: string
  baidu_name?: string
  netdisk_name?: string
  avatar_url?: string
  vip_type?: number
  uk?: number
}

export interface QuotaResponse {
  errno: number
  errmsg?: string
  total?: number
  used?: number
  free?: number
}

export interface FsEntry {
  fs_id?: number
  path: string
  server_filename?: string
  size?: number
  isdir?: number
  category?: number
  md5?: string
  server_mtime?: number
  server_ctime?: number
  thumbs?: Record<string, string>
  width?: number
  height?: number
}

export interface ListResponse {
  errno: number
  errmsg?: string
  list?: FsEntry[]
  request_id?: number
}

export interface FileMeta {
  fs_id?: number
  path?: string
  server_filename?: string
  size?: number
  md5?: string
  category?: number
  dlink?: string
  thumbs?: Record<string, string>
  width?: number
  height?: number
  errno?: number
}

export interface FileMetasResponse {
  errno: number
  errmsg?: string
  list?: FileMeta[]
}

export interface PrecreateResponse {
  errno: number
  errmsg?: string
  path?: string
  uploadid?: string
  /** 实测：1 表示需要上传分片，2 表示云端已有内容。文档只说它是「内部状态字段」 */
  return_type?: number
  block_list?: number[]
  fs_id?: number
}

/** 分片上传响应：成功时不返回 errno，只有 md5 和 request_id */
export interface SliceResponse {
  md5?: string
  request_id?: number
  errno?: number
  errmsg?: string
}

export interface CreateResponse {
  errno: number
  errmsg?: string
  fs_id?: number
  path?: string
  category?: number
  md5?: string
  size?: number
  server_filename?: string
  ctime?: number
  mtime?: number
}

export interface FileManagerResponse {
  errno: number
  errmsg?: string
  info?: Array<{ errno: number; path: string }>
}

export function entryName(entry: FsEntry): string {
  if (entry.server_filename) return entry.server_filename
  const i = entry.path.lastIndexOf('/')
  return i < 0 ? entry.path : entry.path.slice(i + 1)
}

/**
 * 优先取清晰度最高的缩略图。实测百度返回 icon / url1 / url2 / url3 / url4。
 */
export function bestThumbUrl(thumbs: Record<string, string> | undefined): string | null {
  if (!thumbs) return null
  for (const key of ['url4', 'url3', 'url2', 'url1', 'icon']) {
    const v = thumbs[key]
    if (v && v.trim()) return v
  }
  const first = Object.values(thumbs).find((v) => v && v.trim())
  return first ?? null
}

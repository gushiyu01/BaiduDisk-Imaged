import http from './client'
import type {
  AssetDto,
  AssetKind,
  AssetListQuery,
  AssetListResult,
  DeleteAssetResult,
  DeleteMode,
  FavoriteRequest,
  KindStatsResult,
  RenameAssetRequest,
  SetAssetTagsRequest,
  SyncRequest,
  SyncResult,
  UploadResult
} from '../types'

/**
 * 文件库接口。/api/files 与 /api/images 是同一套处理器的两个前缀：
 * files 不限类型，images 等价于把 kind 固定成 IMAGE。
 */

/** GET /api/files */
export async function listFiles(query: AssetListQuery = {}): Promise<AssetListResult> {
  const res = await http.get<AssetListResult>('/files', { params: query })
  return res.data
}

/** GET /api/files/kind-stats —— 各类型数量，给筛选栏显示角标 */
export async function fetchKindStats(): Promise<KindStatsResult> {
  const res = await http.get<KindStatsResult>('/files/kind-stats')
  return res.data
}

/** GET /api/files/{id} */
export async function getFile(id: number): Promise<AssetDto> {
  const res = await http.get<AssetDto>(`/files/${id}`)
  return res.data
}

/**
 * 缩略图地址（后端代理 / 生成并缓存）。
 * 只有 img.thumbnailable 为 true 时才该请求，否则后端返回 415。
 */
export function fileThumbUrl(id: number): string {
  return `/api/files/${id}/thumb`
}

/** 原文件地址。download=true 时后端会带 Content-Disposition，浏览器直接存盘。 */
export function fileRawUrl(id: number, download = false): string {
  return `/api/files/${id}/raw${download ? '?download=1' : ''}`
}

/**
 * 直接触发浏览器下载。
 * 用 Location 跳转而不是 fetch：大文件不必先读进内存成 blob 再落盘。
 */
export function downloadFile(asset: Pick<AssetDto, 'id'>): void {
  const a = document.createElement('a')
  a.href = fileRawUrl(asset.id, true)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** POST /api/files/upload —— 任意类型，字段名 file，可重复 */
export async function uploadFiles(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<UploadResult> {
  const form = new FormData()
  for (const file of files) {
    form.append('file', file, file.name)
  }
  const res = await http.post<UploadResult>('/files/upload', form, {
    onUploadProgress: (event) => {
      if (!onProgress) return
      const total = event.total ?? 0
      if (total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / total) * 100)))
      }
    }
  })
  return res.data
}

/** PATCH /api/files/{id} */
export async function renameFile(id: number, name: string): Promise<AssetDto> {
  const body: RenameAssetRequest = { name }
  const res = await http.patch<AssetDto>(`/files/${id}`, body)
  return res.data
}

/** PATCH /api/files/{id}/favorite */
export async function setFileFavorite(id: number, favorite: boolean): Promise<AssetDto> {
  const body: FavoriteRequest = { favorite }
  const res = await http.patch<AssetDto>(`/files/${id}/favorite`, body)
  return res.data
}

/** POST /api/files/{id}/tags —— 全量覆盖 */
export async function setFileTags(id: number, tagIds: number[]): Promise<AssetDto> {
  const body: SetAssetTagsRequest = { tagIds }
  const res = await http.post<AssetDto>(`/files/${id}/tags`, body)
  return res.data
}

/** DELETE /api/files/{id}?mode=... */
export async function deleteFile(id: number, mode: DeleteMode): Promise<DeleteAssetResult> {
  const res = await http.delete<DeleteAssetResult>(`/files/${id}`, { params: { mode } })
  return res.data
}

/** POST /api/files/sync */
export async function syncFiles(body: SyncRequest = {}): Promise<SyncResult> {
  const res = await http.post<SyncResult>('/files/sync', body)
  return res.data
}

/** 类型筛选器的固定顺序，和后端 kind-stats 的顺序一致 */
export const ASSET_KIND_ORDER: AssetKind[] = ['IMAGE', 'VIDEO', 'AUDIO', 'DOC', 'OTHER']

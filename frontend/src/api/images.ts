import http from './client'
import type {
  DeleteAssetResult,
  DeleteMode,
  AssetDto,
  AssetListQuery,
  AssetListResult,
  SetAssetTagsRequest,
  SyncRequest,
  SyncResult,
  RenameAssetRequest,
  UploadResult
} from '../types'

/** GET /api/images */
export async function listImages(query: AssetListQuery = {}): Promise<AssetListResult> {
  const res = await http.get<AssetListResult>('/images', { params: query })
  return res.data
}

/** GET /api/images/{id} */
export async function getImage(id: number): Promise<AssetDto> {
  const res = await http.get<AssetDto>(`/images/${id}`)
  return res.data
}

/** 缩略图地址（后端代理 / 生成并缓存） */
export function thumbUrl(id: number): string {
  return `/api/images/${id}/thumb`
}

/** 原图地址（支持 Range，直连 img 标签可用） */
export function rawUrl(id: number): string {
  return `/api/images/${id}/raw`
}

/**
 * POST /api/images/upload
 * multipart/form-data，字段名 file，可重复传多个。
 */
export async function uploadImages(
  files: File[],
  onProgress?: (percent: number) => void
): Promise<UploadResult> {
  const form = new FormData()
  for (const file of files) {
    form.append('file', file, file.name)
  }
  const res = await http.post<UploadResult>('/images/upload', form, {
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

/** PATCH /api/images/{id} → 409 同名冲突 / 400 非法文件名 */
export async function updateImage(id: number, payload: RenameAssetRequest): Promise<AssetDto> {
  const res = await http.patch<AssetDto>(`/images/${id}`, payload)
  return res.data
}

/** PATCH /api/images/{id}/favorite */
export async function setFavorite(id: number, favorite: boolean): Promise<AssetDto> {
  const res = await http.patch<AssetDto>(`/images/${id}/favorite`, { favorite })
  return res.data
}

/** DELETE /api/images/{id}?mode=index|remote|both */
export async function deleteImage(id: number, mode: DeleteMode): Promise<DeleteAssetResult> {
  const res = await http.delete<DeleteAssetResult>(`/images/${id}`, { params: { mode } })
  return res.data
}

/** POST /api/images/{id}/tags → 全量覆盖该图片标签 */
export async function setImageTags(id: number, tagIds: number[]): Promise<AssetDto> {
  const payload: SetAssetTagsRequest = { tagIds }
  const res = await http.post<AssetDto>(`/images/${id}/tags`, payload)
  return res.data
}

/** POST /api/images/sync */
export async function syncImages(payload: SyncRequest = {}): Promise<SyncResult> {
  const res = await http.post<SyncResult>('/images/sync', payload)
  return res.data
}

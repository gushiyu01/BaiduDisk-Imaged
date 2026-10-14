import http from './client'
import type { CreateTagRequest, TagDto, UpdateTagRequest } from '../types'

/** GET /api/tags */
export async function listTags(): Promise<TagDto[]> {
  const res = await http.get<TagDto[]>('/tags')
  return res.data
}

/** POST /api/tags → 201；409 同名标签已存在 */
export async function createTag(payload: CreateTagRequest): Promise<TagDto> {
  const res = await http.post<TagDto>('/tags', payload)
  return res.data
}

/** PATCH /api/tags/{id} */
export async function updateTag(id: number, payload: UpdateTagRequest): Promise<TagDto> {
  const res = await http.patch<TagDto>(`/tags/${id}`, payload)
  return res.data
}

/** DELETE /api/tags/{id} → 204，同时解除与图片的关联 */
export async function deleteTag(id: number): Promise<void> {
  await http.delete(`/tags/${id}`)
}

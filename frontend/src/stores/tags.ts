import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createTag, deleteTag, listTags, updateTag } from '../api/tags'
import { getErrorMessage } from '../api/client'
import type { CreateTagRequest, TagDto, UpdateTagRequest } from '../types'

export const useTagsStore = defineStore('tags', () => {
  const tags = ref<TagDto[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  /** 按 id 快速取标签 */
  const byId = computed<Record<number, TagDto>>(() => {
    const map: Record<number, TagDto> = {}
    for (const tag of tags.value) map[tag.id] = tag
    return map
  })

  async function fetchTags(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      tags.value = await listTags()
      loaded.value = true
    } catch (err) {
      error.value = getErrorMessage(err)
      throw err
    } finally {
      loading.value = false
    }
  }

  /** 已加载过就不重复请求，失败也不阻塞页面 */
  async function ensureLoaded(): Promise<void> {
    if (loaded.value || loading.value) return
    try {
      await fetchTags()
    } catch {
      /* 错误已记录在 error 中，由页面展示 */
    }
  }

  async function addTag(payload: CreateTagRequest): Promise<TagDto> {
    const created = await createTag(payload)
    await fetchTags()
    return created
  }

  async function editTag(id: number, payload: UpdateTagRequest): Promise<TagDto> {
    const updated = await updateTag(id, payload)
    await fetchTags()
    return updated
  }

  async function removeTag(id: number): Promise<void> {
    await deleteTag(id)
    await fetchTags()
  }

  return { tags, loading, loaded, error, byId, fetchTags, ensureLoaded, addTag, editTag, removeTag }
})

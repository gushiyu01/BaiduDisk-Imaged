import { ref } from 'vue'
import { defineStore } from 'pinia'
import { listImages } from '../api/images'
import { getErrorMessage } from '../api/client'
import type { AssetDto, AssetSort } from '../types'

/** 图库筛选 / 分页状态，全部映射到 GET /api/images 的查询参数 */
export const useImagesStore = defineStore('images', () => {
  const items = ref<AssetDto[]>([])
  const total = ref(0)
  const page = ref(1)
  const size = ref(24)
  const q = ref('')
  const sort = ref<AssetSort>('time_desc')
  const favoriteOnly = ref(false)
  const tagIds = ref<number[]>([])

  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  /** 竞态保护：只接受最后一次请求的结果 */
  let sequence = 0

  function resetFilters(): void {
    q.value = ''
    sort.value = 'time_desc'
    favoriteOnly.value = false
    tagIds.value = []
    page.value = 1
  }

  async function fetch(): Promise<void> {
    const mine = ++sequence
    loading.value = true
    try {
      const result = await listImages({
        page: page.value,
        size: size.value,
        q: q.value ? q.value : undefined,
        sort: sort.value,
        favorite: favoriteOnly.value ? true : undefined,
        tag: tagIds.value.length > 0 ? [...tagIds.value] : undefined
      })
      if (mine !== sequence) return
      items.value = Array.isArray(result.items) ? result.items : []
      total.value = typeof result.total === 'number' ? result.total : 0
      if (typeof result.page === 'number' && result.page > 0) page.value = result.page
      if (typeof result.size === 'number' && result.size > 0) size.value = result.size
      error.value = ''
      loaded.value = true
      // 删除/筛选后当前页可能已越界，回退到最后一页
      if (items.value.length === 0 && page.value > 1 && total.value > 0) {
        page.value = Math.max(1, Math.ceil(total.value / size.value))
        await fetch()
      }
    } catch (err) {
      if (mine !== sequence) return
      // 保留已有数据，只展示错误横幅 —— 不渲染空白页
      error.value = getErrorMessage(err)
    } finally {
      if (mine === sequence) loading.value = false
    }
  }

  /** 用服务端返回的最新 DTO 替换列表中的一项（重命名 / 收藏 / 打标签后） */
  function patchItem(updated: AssetDto): void {
    const index = items.value.findIndex((item) => item.id === updated.id)
    if (index >= 0) items.value.splice(index, 1, updated)
  }

  function removeItem(id: number): void {
    const index = items.value.findIndex((item) => item.id === id)
    if (index >= 0) items.value.splice(index, 1)
    if (total.value > 0) total.value -= 1
  }

  return {
    items,
    total,
    page,
    size,
    q,
    sort,
    favoriteOnly,
    tagIds,
    loading,
    loaded,
    error,
    fetch,
    resetFilters,
    patchItem,
    removeItem
  }
})

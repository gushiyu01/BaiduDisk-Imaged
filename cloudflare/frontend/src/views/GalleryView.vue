<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Refresh, Search, UploadFilled } from '@element-plus/icons-vue'
import type { AssetDto, AssetSort } from '../types'
import { setFavorite } from '../api/images'
import { getErrorMessage } from '../api/client'
import { useImagesStore } from '../stores/images'
import { useTagsStore } from '../stores/tags'
import { usePersistedViewMode } from '../utils/viewMode'
import AssetGrid from '../components/AssetGrid.vue'
import ImageUploader from '../components/ImageUploader.vue'
import Lightbox from '../components/Lightbox.vue'
import RenameDialog from '../components/RenameDialog.vue'
import DeleteDialog from '../components/DeleteDialog.vue'
import TagEditDialog from '../components/TagEditDialog.vue'

const imagesStore = useImagesStore()
const tagsStore = useTagsStore()
const router = useRouter()

/* ---------------- 视图模式 ---------------- */

type GalleryViewMode = 'grid' | 'waterfall'

const viewMode = usePersistedViewMode<GalleryViewMode>(
  'picman.gallery.viewMode',
  ['grid', 'waterfall'],
  'grid'
)

const viewOptions: Array<{ value: GalleryViewMode; label: string }> = [
  { value: 'grid', label: '网格' },
  { value: 'waterfall', label: '瀑布流' }
]

/* ---------------- 筛选条件 ---------------- */

const SORT_OPTIONS: Array<{ value: AssetSort; label: string }> = [
  { value: 'time_desc', label: '时间：新 → 旧' },
  { value: 'time_asc', label: '时间：旧 → 新' },
  { value: 'name_asc', label: '名称：A → Z' },
  { value: 'name_desc', label: '名称：Z → A' },
  { value: 'size_desc', label: '大小：大 → 小' },
  { value: 'size_asc', label: '大小：小 → 大' }
]

/** 输入框本地值，300ms 防抖后写入 store.q */
const searchInput = ref(imagesStore.q)
let searchTimer: number | undefined

watch(searchInput, (value) => {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    const next = value.trim()
    if (next === imagesStore.q) return
    imagesStore.q = next
    imagesStore.page = 1
  }, 300)
})

watch(
  () => [
    imagesStore.page,
    imagesStore.size,
    imagesStore.sort,
    imagesStore.favoriteOnly,
    imagesStore.q,
    imagesStore.tagIds.join(',')
  ],
  () => {
    void imagesStore.fetch()
  }
)

function resetFilters(): void {
  searchInput.value = ''
  imagesStore.resetFilters()
  void imagesStore.fetch()
}

const hasFilters = computed(
  () =>
    imagesStore.q !== '' ||
    imagesStore.favoriteOnly ||
    imagesStore.tagIds.length > 0 ||
    imagesStore.sort !== 'time_desc'
)

/* ---------------- 上传 ---------------- */

const showUploader = ref(false)

async function onUploaded(): Promise<void> {
  await imagesStore.fetch()
  await tagsStore.fetchTags().catch(() => undefined)
}

/* ---------------- 卡片操作 ---------------- */

const favoriteBusyId = ref<number | null>(null)

async function toggleFavorite(image: AssetDto): Promise<void> {
  favoriteBusyId.value = image.id
  try {
    const updated = await setFavorite(image.id, !image.favorite)
    imagesStore.patchItem(updated)
    ElMessage.success(updated.favorite ? '已收藏' : '已取消收藏')
    // 处于「仅收藏」视图时，取消收藏后该项不再属于结果集
    if (imagesStore.favoriteOnly && !updated.favorite) {
      await imagesStore.fetch()
    }
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    favoriteBusyId.value = null
  }
}

/* ---------------- 对话框 ---------------- */

const renameVisible = ref(false)
const deleteVisible = ref(false)
const tagEditVisible = ref(false)
const activeImage = ref<AssetDto | null>(null)

function openRename(image: AssetDto): void {
  activeImage.value = image
  renameVisible.value = true
}

function openDelete(image: AssetDto): void {
  activeImage.value = image
  deleteVisible.value = true
}

function openTagEdit(image: AssetDto): void {
  activeImage.value = image
  tagEditVisible.value = true
}

function onRenamed(updated: AssetDto): void {
  imagesStore.patchItem(updated)
}

function onTagsSaved(updated: AssetDto): void {
  imagesStore.patchItem(updated)
  void tagsStore.fetchTags().catch(() => undefined)
}

async function onDeleted(): Promise<void> {
  if (activeImage.value) imagesStore.removeItem(activeImage.value.id)
  await imagesStore.fetch()
  await tagsStore.fetchTags().catch(() => undefined)
}

/* ---------------- 灯箱 ---------------- */

const lightboxIndex = ref(0)
const lightboxOpen = ref(false)

function openLightbox(index: number): void {
  lightboxIndex.value = index
  lightboxOpen.value = true
}

/** 卡片只回传文件本身，灯箱要的是序号，这里反查一次 */
function openByAsset(asset: AssetDto): void {
  const index = imagesStore.items.findIndex((item) => item.id === asset.id)
  if (index >= 0) openLightbox(index)
}

function closeLightbox(): void {
  lightboxOpen.value = false
}

watch(
  () => imagesStore.items.length,
  (length) => {
    if (lightboxOpen.value && length === 0) lightboxOpen.value = false
  }
)

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  void imagesStore.fetch()
  void tagsStore.ensureLoaded()
})

onBeforeUnmount(() => {
  if (searchTimer !== undefined) window.clearTimeout(searchTimer)
})
</script>

<template>
  <div class="picman-page">
    <div class="picman-page-head">
      <div>
        <h1 class="picman-page-title">图库</h1>
        <p class="picman-page-subtitle">
          共 {{ imagesStore.total }} 张图片<span v-if="hasFilters">（已应用筛选条件）</span>
        </p>
      </div>
      <div class="picman-head-actions">
        <el-button :icon="Refresh" :loading="imagesStore.loading" @click="imagesStore.fetch()">
          刷新
        </el-button>
        <el-button type="primary" :icon="UploadFilled" @click="showUploader = !showUploader">
          {{ showUploader ? '收起上传' : '上传图片' }}
        </el-button>
      </div>
    </div>

    <ImageUploader v-show="showUploader" @uploaded="onUploaded" />

    <div class="picman-toolbar">
      <el-input
        v-model="searchInput"
        class="picman-search-input"
        style="width: 220px"
        placeholder="搜索文件名"
        clearable
        :prefix-icon="Search"
      />

      <el-select v-model="imagesStore.sort" class="picman-select-sm" placeholder="排序">
        <el-option v-for="option in SORT_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>

      <el-select
        v-model="imagesStore.tagIds"
        class="picman-select-sm"
        style="width: 220px"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        clearable
        placeholder="按标签筛选"
        :loading="tagsStore.loading"
      >
        <el-option v-for="tag in tagsStore.tags" :key="tag.id" :label="tag.name" :value="tag.id">
          <span class="picman-tag-option">
            <span class="picman-tag-dot" :style="{ backgroundColor: tag.color || '#409EFF' }" />
            {{ tag.name }}
            <span class="picman-tag-count">({{ tag.count }})</span>
          </span>
        </el-option>
      </el-select>

      <el-checkbox v-model="imagesStore.favoriteOnly" border>只看收藏</el-checkbox>

      <div class="picman-toolbar-right">
        <el-button v-if="hasFilters" text type="primary" @click="resetFilters">重置筛选</el-button>
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button v-for="v in viewOptions" :key="v.value" :value="v.value">
            {{ v.label }}
          </el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <el-alert
      v-if="tagsStore.error"
      class="picman-inline-alert"
      type="warning"
      show-icon
      :closable="false"
      title="标签列表加载失败"
      :description="tagsStore.error"
    />

    <el-alert
      v-if="imagesStore.error"
      class="picman-inline-alert"
      type="error"
      show-icon
      :closable="false"
      title="图片列表加载失败"
      :description="imagesStore.error"
    >
      <template #default>
        <div class="picman-alert-body">
          <span>{{ imagesStore.error }}</span>
          <el-button size="small" type="primary" @click="imagesStore.fetch()">重试</el-button>
        </div>
      </template>
    </el-alert>

    <div v-loading="imagesStore.loading" class="picman-grid-wrap">
      <div v-if="imagesStore.items.length > 0">
        <AssetGrid
          :assets="imagesStore.items"
          :mode="viewMode"
          variant="photo"
          :busy-favorite-id="favoriteBusyId"
          @open="openByAsset"
          @rename="openRename"
          @favorite="toggleFavorite"
          @delete="openDelete"
          @tags="openTagEdit"
        />
      </div>

      <div v-else-if="!imagesStore.loading && imagesStore.error" class="picman-empty-block">
        <el-result icon="error" title="加载失败" :sub-title="imagesStore.error">
          <template #extra>
            <el-button type="primary" @click="imagesStore.fetch()">重新加载</el-button>
          </template>
        </el-result>
      </div>

      <div v-else-if="!imagesStore.loading" class="picman-empty-block">
        <el-empty :description="hasFilters ? '没有符合条件的图片' : '图库还是空的'">
          <template #description>
            <p class="picman-empty-title">
              {{ hasFilters ? '没有符合条件的图片' : '图库还是空的' }}
            </p>
            <p class="picman-empty-sub">
              {{
                hasFilters
                  ? '试着调整搜索关键词、标签或收藏筛选。'
                  : '上传图片，或到「百度网盘」页执行「同步索引」把网盘里的图片导入进来。'
              }}
            </p>
          </template>
          <div class="picman-empty-actions">
            <el-button v-if="hasFilters" @click="resetFilters">重置筛选</el-button>
            <el-button v-else type="primary" @click="showUploader = true">上传图片</el-button>
            <el-button v-if="!hasFilters" @click="router.push('/baidu')">去同步索引</el-button>
          </div>
        </el-empty>
      </div>
    </div>

    <div v-if="imagesStore.total > 0" class="picman-pagination">
      <el-pagination
        v-model:current-page="imagesStore.page"
        v-model:page-size="imagesStore.size"
        :total="imagesStore.total"
        :page-sizes="[12, 24, 48, 96]"
        layout="total, sizes, prev, pager, next, jumper"
        background
        :hide-on-single-page="false"
      />
    </div>

    <RenameDialog v-model="renameVisible" :image="activeImage" @renamed="onRenamed" />
    <DeleteDialog v-model="deleteVisible" :image="activeImage" @deleted="onDeleted" />
    <TagEditDialog v-model="tagEditVisible" :image="activeImage" @saved="onTagsSaved" />

    <Lightbox
      v-if="lightboxOpen && imagesStore.items.length > 0"
      :images="imagesStore.items"
      :index="lightboxIndex"
      @close="closeLightbox"
      @update:index="(value: number) => (lightboxIndex = value)"
    />
  </div>
</template>

<style scoped>
.picman-head-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.picman-inline-alert {
  margin-bottom: 12px;
}

.picman-alert-body {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.picman-grid-wrap {
  min-height: 200px;
}

.picman-pagination {
  display: flex;
  justify-content: center;
  padding: 16px 0 8px;
}

.picman-empty-title {
  margin: 0 0 6px;
  font-size: 15px;
  color: var(--el-text-color-primary);
}

.picman-empty-sub {
  max-width: 460px;
  margin: 0 auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.picman-empty-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.picman-tag-option {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.picman-tag-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.picman-tag-count {
  color: var(--el-text-color-secondary);
}
</style>

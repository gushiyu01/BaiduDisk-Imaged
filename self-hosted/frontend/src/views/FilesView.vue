<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { getErrorMessage } from '../api/client'
import {
  ASSET_KIND_ORDER,
  deleteFile,
  downloadFile,
  fetchKindStats,
  fileRawUrl,
  fileThumbUrl,
  listFiles,
  renameFile,
  setFileFavorite,
  setFileTags,
  uploadFiles
} from '../api/files'
import { useTagsStore } from '../stores/tags'
import type { AssetDto, AssetKind, AssetSort, UploadFailure } from '../types'
import { ASSET_KIND_LABELS } from '../types'
import { formatBytes, formatDateTime, formatDimensions } from '../utils/format'
import { isPlayableKind, kindStyle } from '../utils/kinds'
import { usePersistedViewMode } from '../utils/viewMode'
import AssetGrid from '../components/AssetGrid.vue'
import Lightbox from '../components/Lightbox.vue'
import MediaViewer from '../components/MediaViewer.vue'
import RenameDialog from '../components/RenameDialog.vue'
import DeleteDialog from '../components/DeleteDialog.vue'
import TagEditDialog from '../components/TagEditDialog.vue'

const tagsStore = useTagsStore()

/* -------------------- 视图模式 -------------------- */

export type FilesViewMode = 'table' | 'grid' | 'waterfall'

const viewMode = usePersistedViewMode<FilesViewMode>(
  'picman.files.viewMode',
  ['table', 'grid', 'waterfall'],
  'table'
)

/** AssetGrid 只认 grid / waterfall，把 table 收窄掉 */
const tileMode = computed<'grid' | 'waterfall'>(() =>
  viewMode.value === 'waterfall' ? 'waterfall' : 'grid'
)

const viewOptions: Array<{ value: FilesViewMode; label: string }> = [
  { value: 'table', label: '表格' },
  { value: 'grid', label: '网格' },
  { value: 'waterfall', label: '瀑布流' }
]

/* -------------------- 列表状态 -------------------- */

const items = ref<AssetDto[]>([])
const total = ref(0)
const loading = ref(false)
const error = ref('')

const page = ref(1)
const size = ref(24)
const sort = ref<AssetSort>('time_desc')
const kind = ref<AssetKind | ''>('')
const favoriteOnly = ref(false)
const searchInput = ref('')
const searchTerm = ref('')
const selectedTags = ref<number[]>([])

const kindCounts = reactive<Record<string, number>>({})
const totalFiles = ref(0)

/** 类型筛选器：全部 + 五个大类，数量来自后端 kind-stats */
const kindOptions = computed(() => {
  const opts: Array<{ value: AssetKind | ''; label: string; count: number }> = [
    { value: '', label: '全部', count: totalFiles.value }
  ]
  for (const k of ASSET_KIND_ORDER) {
    opts.push({ value: k, label: ASSET_KIND_LABELS[k], count: kindCounts[k] ?? 0 })
  }
  return opts
})

const sortOptions: Array<{ value: AssetSort; label: string }> = [
  { value: 'time_desc', label: '时间：新 → 旧' },
  { value: 'time_asc', label: '时间：旧 → 新' },
  { value: 'name_asc', label: '名称：A → Z' },
  { value: 'name_desc', label: '名称：Z → A' },
  { value: 'size_desc', label: '大小：大 → 小' },
  { value: 'size_asc', label: '大小：小 → 大' }
]

const hasFilters = computed(
  () =>
    searchTerm.value !== '' ||
    kind.value !== '' ||
    favoriteOnly.value ||
    selectedTags.value.length > 0
)

/* -------------------- 数据加载 -------------------- */

/**
 * 竞态保护：搜索、翻页、切筛选都会并发触发 load()，只接受最后一次的结果。
 * 没有这道保护时，先发出的请求若后返回，会把列表覆盖成旧条件的内容 ——
 * 界面上的筛选条件和列表对不上。做法与图库 store 一致。
 */
let loadSequence = 0

async function load(): Promise<void> {
  const mine = ++loadSequence
  loading.value = true
  error.value = ''
  try {
    const result = await listFiles({
      page: page.value,
      size: size.value,
      sort: sort.value,
      q: searchTerm.value || undefined,
      kind: kind.value || undefined,
      favorite: favoriteOnly.value ? true : undefined,
      tag: selectedTags.value.length > 0 ? selectedTags.value : undefined
    })
    if (mine !== loadSequence) return
    items.value = result.items
    total.value = result.total
  } catch (err) {
    if (mine !== loadSequence) return
    error.value = getErrorMessage(err)
    // 失败时保留列表，不清空成白屏
  } finally {
    if (mine === loadSequence) loading.value = false
  }
}

async function loadKindStats(): Promise<void> {
  try {
    const stats = await fetchKindStats()
    for (const k of stats.kinds) {
      kindCounts[k.kind] = k.count
    }
    totalFiles.value = stats.total
  } catch {
    // 角标拿不到不影响主功能
  }
}

function resetFilters(): void {
  searchInput.value = ''
  searchTerm.value = ''
  kind.value = ''
  favoriteOnly.value = false
  selectedTags.value = []
  page.value = 1
  void load()
}

let searchTimer: number | undefined
watch(searchInput, (value) => {
  window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    searchTerm.value = value.trim()
    page.value = 1
    void load()
  }, 300)
})

watch([sort, kind, favoriteOnly, selectedTags], () => {
  page.value = 1
  void load()
})

watch([page, size], () => void load())

onMounted(async () => {
  await Promise.all([load(), loadKindStats(), tagsStore.ensureLoaded().catch(() => undefined)])
})

/* -------------------- 上传 -------------------- */

const uploading = ref(false)
const uploadPercent = ref(0)
const uploadFailures = ref<UploadFailure[]>([])

async function handleFilesPicked(files: File[]): Promise<void> {
  if (files.length === 0) return
  uploading.value = true
  uploadPercent.value = 0
  uploadFailures.value = []
  try {
    const result = await uploadFiles(files, (p) => (uploadPercent.value = p))
    uploadFailures.value = result.failed
    if (result.uploaded.length > 0) {
      ElMessage.success(`已上传 ${result.uploaded.length} 个文件`)
      page.value = 1
      await load()
      await loadKindStats()
    }
    if (result.failed.length > 0) {
      ElMessage.warning(`${result.failed.length} 个文件上传失败，详见下方说明`)
    }
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    uploading.value = false
  }
}

function onUploadInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = '' // 允许连续选同一个文件
  void handleFilesPicked(files)
}

const uploadInput = ref<HTMLInputElement | null>(null)

/* -------------------- 行操作 -------------------- */

const favoriteBusyId = ref<number | null>(null)

async function toggleFavorite(asset: AssetDto): Promise<void> {
  favoriteBusyId.value = asset.id
  try {
    const updated = await setFileFavorite(asset.id, !asset.favorite)
    replaceItem(updated)
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    favoriteBusyId.value = null
  }
}

function replaceItem(updated: AssetDto): void {
  const index = items.value.findIndex((i) => i.id === updated.id)
  if (index >= 0) {
    items.value[index] = updated
  }
}

const renameVisible = ref(false)
const deleteVisible = ref(false)
const tagEditVisible = ref(false)
const activeAsset = ref<AssetDto | null>(null)

function openRename(asset: AssetDto): void {
  activeAsset.value = asset
  renameVisible.value = true
}

function openDelete(asset: AssetDto): void {
  activeAsset.value = asset
  deleteVisible.value = true
}

function openTagEdit(asset: AssetDto): void {
  activeAsset.value = asset
  tagEditVisible.value = true
}

async function onRenamed(updated: AssetDto): Promise<void> {
  replaceItem(updated)
  await loadKindStats()
}

async function onDeleted(): Promise<void> {
  await load()
  await loadKindStats()
}

async function onTagsSaved(updated: AssetDto): Promise<void> {
  replaceItem(updated)
  await loadKindStats()
}

function handleDownload(asset: AssetDto): void {
  downloadFile(asset)
}

/* -------------------- 图片预览 / 媒体播放 -------------------- */

const lightboxOpen = ref(false)
const lightboxIndex = ref(0)
const mediaOpen = ref(false)
const mediaIndex = ref(0)

/** 相册只包含当前页里能预览的图片，翻页不会跨到别的页 */
const previewableImages = computed(() => items.value.filter((i) => i.kind === 'IMAGE'))
/** 播放列表同理，只含当前页的视频与音频 */
const playableMedia = computed(() =>
  items.value.filter((i) => i.kind === 'VIDEO' || i.kind === 'AUDIO')
)

/** 音频走底部迷你条而不是全屏遮罩，需要给页面腾出下边距，否则会压住分页 */
const audioBarVisible = computed(
  () => mediaOpen.value && playableMedia.value[mediaIndex.value]?.kind === 'AUDIO'
)

function openLightbox(asset: AssetDto): void {
  const index = previewableImages.value.findIndex((i) => i.id === asset.id)
  if (index < 0) return
  lightboxIndex.value = index
  lightboxOpen.value = true
}

function openMedia(asset: AssetDto): void {
  const index = playableMedia.value.findIndex((i) => i.id === asset.id)
  if (index < 0) return
  mediaIndex.value = index
  mediaOpen.value = true
}

function isPlayable(asset: AssetDto): boolean {
  return isPlayableKind(asset.kind)
}

/**
 * 点卡片/文件名的统一入口：
 * 视频音频进播放器，图片进灯箱，其余交给浏览器——PDF 会内联打开，压缩包直接下载。
 */
function openAsset(asset: AssetDto): void {
  if (isPlayable(asset)) {
    openMedia(asset)
    return
  }
  if (asset.kind === 'IMAGE') {
    openLightbox(asset)
    return
  }
  window.open(fileRawUrl(asset.id), '_blank', 'noopener')
}

/**
 * 缩略图加载失败时回退成类型图标。
 * <p>
 * 主要是为了视频：百度给视频生成封面是异步的，刚上传完立刻请求会拿不到，
 * 过一会儿才可用。不回退的话列表里会出现一堆裂图。
 */
const thumbFailed = ref<Set<number>>(new Set())

function onThumbError(id: number): void {
  const next = new Set(thumbFailed.value)
  next.add(id)
  thumbFailed.value = next
}

function showThumb(asset: AssetDto): boolean {
  return asset.thumbnailable && !thumbFailed.value.has(asset.id)
}

/** 供模板里按 id 反查缩略图地址 */
function thumbOf(asset: AssetDto): string {
  return fileThumbUrl(asset.id)
}
</script>

<template>
  <div class="picman-page" :class="{ 'picman-page--with-audiobar': audioBarVisible }">
    <div class="picman-page-head">
      <div>
        <h1 class="picman-page-title">文件库</h1>
        <p class="picman-page-sub">
          共 {{ totalFiles }} 个文件<span v-if="hasFilters">，当前筛选出 {{ total }} 个</span>
        </p>
      </div>
      <div class="picman-page-actions">
        <el-button :icon="'Refresh'" :loading="loading" @click="load">刷新</el-button>
        <el-button
          type="primary"
          :icon="'UploadFilled'"
          :loading="uploading"
          @click="uploadInput?.click()"
        >
          上传文件
        </el-button>
        <input ref="uploadInput" type="file" multiple hidden @change="onUploadInputChange" />
      </div>
    </div>

    <el-alert
      v-if="uploading || uploadFailures.length > 0"
      class="picman-upload-status"
      :type="uploadFailures.length > 0 ? 'warning' : 'info'"
      :closable="!uploading"
      show-icon
      @close="uploadFailures = []"
    >
      <template #title>
        <span v-if="uploading">正在上传… {{ uploadPercent }}%</span>
        <span v-else>{{ uploadFailures.length }} 个文件上传失败</span>
      </template>
      <el-progress v-if="uploading" :percentage="uploadPercent" :show-text="false" />
      <ul v-else class="picman-upload-failures">
        <li v-for="(f, i) in uploadFailures" :key="i">
          <strong>{{ f.name }}</strong>：{{ f.reason }}
        </li>
      </ul>
    </el-alert>

    <!-- 类型筛选 -->
    <div class="picman-kind-bar">
      <el-radio-group v-model="kind" size="default">
        <el-radio-button v-for="opt in kindOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
          <span class="picman-kind-count">{{ opt.count }}</span>
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- 搜索与排序 -->
    <div class="picman-toolbar">
      <el-input
        v-model="searchInput"
        class="picman-search"
        placeholder="搜索文件名"
        clearable
        :prefix-icon="'Search'"
      />
      <el-select v-model="sort" class="picman-sort" placeholder="排序">
        <el-option v-for="o in sortOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <el-select
        v-model="selectedTags"
        class="picman-tag-filter"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="按标签筛选"
        clearable
      >
        <el-option v-for="t in tagsStore.tags" :key="t.id" :label="t.name" :value="t.id" />
      </el-select>
      <el-checkbox v-model="favoriteOnly" label="只看收藏" />
      <el-button v-if="hasFilters" text type="primary" @click="resetFilters">重置筛选</el-button>

      <el-radio-group v-model="viewMode" size="small" class="picman-view-switch">
        <el-radio-button v-for="v in viewOptions" :key="v.value" :value="v.value">
          {{ v.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <!-- 列表 -->
    <el-alert
      v-if="error"
      class="picman-error"
      type="error"
      show-icon
      :title="error"
      :closable="false"
    >
      <template #default>
        <el-button size="small" type="primary" @click="load">重试</el-button>
      </template>
    </el-alert>

    <el-table
      v-if="viewMode === 'table'"
      v-loading="loading"
      :data="items"
      class="picman-files-table"
      row-key="id"
      :empty-text="hasFilters ? '没有符合条件的文件' : '文件库还是空的'"
    >
      <el-table-column label="预览" width="72" align="center">
        <template #default="{ row }">
          <div class="picman-kind-cell">
            <img
              v-if="showThumb(row)"
              class="picman-kind-thumb"
              :src="thumbOf(row)"
              :alt="row.name"
              loading="lazy"
              @error="onThumbError(row.id)"
            />
            <el-icon v-else class="picman-kind-icon" :size="22">
              <component :is="kindStyle(row.kind).icon" />
            </el-icon>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="名称" min-width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="picman-name-cell">
            <el-icon v-if="row.favorite" class="picman-star" color="#f7ba2a"><StarFilled /></el-icon>
            <el-button
              v-if="row.kind === 'IMAGE' || isPlayable(row)"
              text
              type="primary"
              class="picman-name-link"
              :title="isPlayable(row) ? '点击播放' : '点击预览'"
              @click="openAsset(row)"
            >
              {{ row.name }}
            </el-button>
            <span v-else class="picman-name-text">{{ row.name }}</span>
            <el-tag
              v-if="row.missing"
              size="small"
              type="danger"
              effect="plain"
              class="picman-missing-tag"
            >
              网盘已删除
            </el-tag>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="类型" width="86">
        <template #default="{ row }">
          <el-tag
            size="small"
            :type="kindStyle(row.kind).tagType || undefined"
            effect="plain"
          >
            {{ ASSET_KIND_LABELS[row.kind as AssetKind] }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="大小" width="110">
        <template #default="{ row }">
          <span class="picman-mono">{{ formatBytes(row.size) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="尺寸" width="120">
        <template #default="{ row }">
          <span v-if="row.kind === 'IMAGE'" class="picman-mono">
            {{ formatDimensions(row.width, row.height) }}
          </span>
          <span v-else class="picman-dim">-</span>
        </template>
      </el-table-column>

      <el-table-column label="修改时间" width="170">
        <template #default="{ row }">
          <span class="picman-mono">{{ formatDateTime(row.serverMtime) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="标签" min-width="140">
        <template #default="{ row }">
          <el-tag
            v-for="t in row.tags"
            :key="t.id"
            size="small"
            :color="t.color"
            effect="dark"
            class="picman-row-tag"
          >
            {{ t.name }}
          </el-tag>
          <span v-if="row.tags.length === 0" class="picman-dim">-</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <el-button
            size="small"
            circle
            :icon="'Download'"
            title="下载"
            @click="handleDownload(row)"
          />
          <el-button
            size="small"
            circle
            :icon="row.favorite ? 'StarFilled' : 'Star'"
            :loading="favoriteBusyId === row.id"
            :title="row.favorite ? '取消收藏' : '收藏'"
            @click="toggleFavorite(row)"
          />
          <el-button size="small" circle :icon="'EditPen'" title="重命名" @click="openRename(row)" />
          <el-button
            size="small"
            circle
            :icon="'PriceTag'"
            title="编辑标签"
            @click="openTagEdit(row)"
          />
          <el-button
            size="small"
            circle
            type="danger"
            :icon="'Delete'"
            title="删除"
            @click="openDelete(row)"
          />
        </template>
      </el-table-column>
    </el-table>

    <!-- 网格 / 瀑布流 -->
    <div v-else v-loading="loading" class="picman-cards-wrap">
      <AssetGrid
        v-if="items.length > 0"
        :assets="items"
        :mode="tileMode"
        variant="file"
        :busy-favorite-id="favoriteBusyId"
        @open="openAsset"
        @rename="openRename"
        @favorite="toggleFavorite"
        @delete="openDelete"
        @tags="openTagEdit"
        @download="handleDownload"
      />

      <div v-else-if="!loading" class="picman-empty-block">
        <el-empty :description="hasFilters ? '没有符合条件的文件' : '文件库还是空的'">
          <template #description>
            <p class="picman-empty-title">
              {{ hasFilters ? '没有符合条件的文件' : '文件库还是空的' }}
            </p>
            <p class="picman-empty-sub">
              {{
                hasFilters
                  ? '试着调整搜索关键词、类型或标签筛选。'
                  : '上传文件，或到「百度网盘」页执行「同步索引」把网盘里的文件导入进来。'
              }}
            </p>
          </template>
          <div class="picman-empty-actions">
            <el-button v-if="hasFilters" @click="resetFilters">重置筛选</el-button>
            <el-button v-else type="primary" @click="uploadInput?.click()">上传文件</el-button>
          </div>
        </el-empty>
      </div>
    </div>

    <div v-if="total > 0" class="picman-pagination">
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="size"
        :total="total"
        :page-sizes="[12, 24, 48, 96]"
        layout="total, sizes, prev, pager, next, jumper"
        background
        :hide-on-single-page="false"
      />
    </div>

    <RenameDialog v-model="renameVisible" :image="activeAsset" @renamed="onRenamed" />
    <DeleteDialog v-model="deleteVisible" :image="activeAsset" @deleted="onDeleted" />
    <TagEditDialog v-model="tagEditVisible" :image="activeAsset" @saved="onTagsSaved" />

    <Lightbox
      v-if="lightboxOpen && previewableImages.length > 0"
      :images="previewableImages"
      :index="lightboxIndex"
      @close="lightboxOpen = false"
      @update:index="(value: number) => (lightboxIndex = value)"
    />

    <MediaViewer
      v-if="mediaOpen && playableMedia.length > 0"
      :assets="playableMedia"
      :index="mediaIndex"
      @close="mediaOpen = false"
      @update:index="(value: number) => (mediaIndex = value)"
    />
  </div>
</template>

<style scoped>
.picman-page {
  max-width: 1440px;
  padding: 20px 16px 40px;
  margin: 0 auto;
}

/*
 * 底部有音频播放条时留出空间，别让它压住分页。
 * 刻意不加 transition：过渡期间 getComputedStyle 返回的是动画中间帧，
 * 在渲染被节流的环境里（后台标签页、某些内嵌浏览器）过渡不推进，
 * padding 会永远停在变化前的值，表现成「开着播放条反而没留出空间」。
 */
.picman-page--with-audiobar {
  padding-bottom: 110px;
}

.picman-page-head {
  display: flex;
  gap: 16px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 14px;
}

.picman-page-title {
  margin: 0 0 4px;
  font-size: 22px;
}

.picman-page-sub {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.picman-page-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}

.picman-upload-status {
  margin-bottom: 14px;
}

.picman-upload-failures {
  padding-left: 18px;
  margin: 4px 0 0;
  font-size: 13px;
}

.picman-kind-bar {
  margin-bottom: 12px;
  overflow-x: auto;
}

.picman-kind-count {
  margin-left: 4px;
  font-size: 12px;
  opacity: 0.75;
}

.picman-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}

.picman-search {
  width: 240px;
}

/* 视图切换靠右，和左侧的筛选条件分开 */
.picman-view-switch {
  margin-left: auto;
}

.picman-cards-wrap {
  min-height: 220px;
}

.picman-empty-block {
  padding: 32px 0;
}

.picman-empty-title {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.picman-empty-sub {
  max-width: 380px;
  margin: 0 auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}

.picman-empty-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-top: 12px;
}

.picman-sort {
  width: 160px;
}

.picman-tag-filter {
  width: 220px;
}

.picman-error {
  margin-bottom: 14px;
}

.picman-files-table {
  width: 100%;
}

.picman-kind-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 44px;
}

.picman-kind-thumb {
  width: 44px;
  height: 44px;
  object-fit: cover;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.picman-kind-icon {
  color: var(--el-text-color-secondary);
}

.picman-name-cell {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.picman-star {
  flex: 0 0 auto;
}

.picman-name-link {
  padding: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-missing-tag {
  flex: 0 0 auto;
}

.picman-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.picman-dim {
  color: var(--el-text-color-placeholder);
}

.picman-row-tag {
  margin: 0 4px 2px 0;
}

.picman-pagination {
  display: flex;
  justify-content: center;
  margin-top: 18px;
}

@media (max-width: 900px) {
  .picman-page-head {
    flex-direction: column;
  }

  .picman-search,
  .picman-sort,
  .picman-tag-filter {
    width: 100%;
  }
}
</style>

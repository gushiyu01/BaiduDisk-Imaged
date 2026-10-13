<script setup lang="ts">
import type { AssetDto } from '../types'
import AssetTile from './AssetTile.vue'

const props = defineProps<{
  assets: AssetDto[]
  /**
   * grid = 等高方格，整齐、扫视快；
   * waterfall = 按文件真实比例排布，图片多的目录观感更好。
   */
  mode: 'grid' | 'waterfall'
  /** photo = 图库；file = 文件库 */
  variant: 'photo' | 'file'
  busyFavoriteId?: number | null
}>()

const emit = defineEmits<{
  (e: 'open', asset: AssetDto): void
  (e: 'rename', asset: AssetDto): void
  (e: 'favorite', asset: AssetDto): void
  (e: 'delete', asset: AssetDto): void
  (e: 'tags', asset: AssetDto): void
  (e: 'download', asset: AssetDto): void
}>()

/** 瀑布流没有真实尺寸的文件（文档、压缩包）统一用这个高度，避免整列忽高忽低 */
const waterfallNotes = '瀑布流按列自上而下排布，阅读顺序与表格视图不同'
</script>

<template>
  <div
    class="picman-assets"
    :class="[`is-${mode}`, `is-${variant}`]"
    :data-note="mode === 'waterfall' ? waterfallNotes : undefined"
  >
    <AssetTile
      v-for="asset in assets"
      :key="asset.id"
      :asset="asset"
      :mode="mode"
      :variant="variant"
      :busy="busyFavoriteId === asset.id"
      @open="emit('open', asset)"
      @rename="emit('rename', asset)"
      @favorite="emit('favorite', asset)"
      @delete="emit('delete', asset)"
      @tags="emit('tags', asset)"
      @download="emit('download', asset)"
    />
  </div>
</template>

<style scoped>
/* -------------------- 网格：等高方格 -------------------- */

.picman-assets.is-grid {
  display: grid;
  gap: 14px;
}

.picman-assets.is-grid.is-file {
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
}

.picman-assets.is-grid.is-photo {
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
}

/* -------------------- 瀑布流：按真实比例的多列 -------------------- */

/*
 * 用 CSS 多列而不是 JS 算位置：不需要监听容器宽度、不用在窗口缩放时重排，
 * 卡片高度由自身宽高比决定，浏览器自己平衡各列高度。
 * 代价是阅读顺序变成「先第一列从上到下，再第二列」，这点在页面上有提示。
 */
.picman-assets.is-waterfall {
  columns: 200px;
  column-gap: 14px;
}

.picman-assets.is-waterfall.is-photo {
  columns: 240px;
}

@media (max-width: 640px) {
  .picman-assets.is-waterfall {
    columns: 150px;
  }

  .picman-assets.is-grid.is-file,
  .picman-assets.is-grid.is-photo {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  }
}
</style>

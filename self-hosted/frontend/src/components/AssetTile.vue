<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AssetDto, AssetKind } from '../types'
import { ASSET_KIND_LABELS } from '../types'
import { fileThumbUrl } from '../api/files'
import { formatBytes, formatDimensions } from '../utils/format'
import { isMediaKind, kindStyle } from '../utils/kinds'

const props = defineProps<{
  asset: AssetDto
  /** grid = 等高方格；waterfall = 按真实比例，形成瀑布流 */
  mode: 'grid' | 'waterfall'
  /** photo = 图库（弱化元信息）；file = 文件库（显示类型与更多操作） */
  variant: 'photo' | 'file'
  /** 收藏切换请求进行中 */
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'open'): void
  (e: 'rename'): void
  (e: 'favorite'): void
  (e: 'delete'): void
  (e: 'tags'): void
  (e: 'download'): void
}>()

/** 图片加载失败就退回类型图标——百度给视频出封面是异步的，刚传完常常还拿不到 */
const thumbFailed = ref(false)

const kind = computed<AssetKind>(() => props.asset.kind)
const style = computed(() => kindStyle(kind.value))

const showThumb = computed(
  () => props.asset.thumbnailable && isMediaKind(kind.value) && !thumbFailed.value
)

const thumbSrc = computed(() => fileThumbUrl(props.asset.id))

/**
 * 瀑布流用文件真实宽高比，这样图片还没下载完占位高度就是对的，不会加载完再跳一下。
 * 极端比例会夹到 0.6~2.0，否则全景图会压成一条线、长图会撑满整屏。
 */
const aspectRatio = computed(() => {
  if (props.mode === 'grid') {
    return 1
  }
  const { width, height } = props.asset
  if (isMediaKind(kind.value) && width && height && width > 0 && height > 0) {
    return Math.min(2, Math.max(0.6, width / height))
  }
  return style.value.fallbackRatio
})

const sizeText = computed(() => formatBytes(props.asset.size))

/** 图片显示尺寸，其它类型没有尺寸可言 */
const detailText = computed(() => {
  if (kind.value === 'IMAGE') {
    return formatDimensions(props.asset.width, props.asset.height)
  }
  if (props.asset.ext) {
    return props.asset.ext.toUpperCase()
  }
  return '—'
})

const visibleTags = computed(() => props.asset.tags.slice(0, 2))
const moreTags = computed(() => Math.max(0, props.asset.tags.length - visibleTags.value.length))

const title = computed(
  () =>
    `${props.asset.name}\n${ASSET_KIND_LABELS[kind.value]} · ${detailText.value} · ${sizeText.value}` +
    `\n${props.asset.path}`
)
</script>

<template>
  <div
    class="picman-tile"
    :class="[`is-${mode}`, `is-${variant}`]"
    :title="title"
    @click="emit('open')"
  >
    <div class="picman-tile-thumb" :style="{ aspectRatio: String(aspectRatio) }">
      <img
        v-if="showThumb"
        class="picman-tile-img"
        :src="thumbSrc"
        :alt="asset.name"
        loading="lazy"
        decoding="async"
        @error="thumbFailed = true"
      />
      <div v-else class="picman-tile-kind">
        <el-icon :size="variant === 'photo' ? 30 : 26">
          <component :is="style.icon" />
        </el-icon>
        <span v-if="!showThumb && thumbFailed" class="picman-tile-kind-note">缩略图不可用</span>
      </div>

      <el-tag
        v-if="variant === 'file'"
        class="picman-tile-kindbadge"
        size="small"
        effect="dark"
        :type="style.tagType || undefined"
      >
        {{ ASSET_KIND_LABELS[kind] }}
      </el-tag>

      <span v-if="asset.favorite" class="picman-tile-fav" title="已收藏">
        <el-icon><StarFilled /></el-icon>
      </span>

      <span v-if="asset.missing" class="picman-tile-missing">网盘已删除</span>

      <div class="picman-tile-actions" @click.stop>
        <el-tooltip v-if="variant === 'file'" content="下载" placement="top" :show-after="300">
          <el-button size="small" circle :icon="'Download'" @click="emit('download')" />
        </el-tooltip>
        <el-tooltip content="重命名" placement="top" :show-after="300">
          <el-button size="small" circle :icon="'EditPen'" @click="emit('rename')" />
        </el-tooltip>
        <el-tooltip
          :content="asset.favorite ? '取消收藏' : '收藏'"
          placement="top"
          :show-after="300"
        >
          <el-button
            size="small"
            circle
            :loading="busy"
            :icon="asset.favorite ? 'StarFilled' : 'Star'"
            @click="emit('favorite')"
          />
        </el-tooltip>
        <el-tooltip content="编辑标签" placement="top" :show-after="300">
          <el-button size="small" circle :icon="'PriceTag'" @click="emit('tags')" />
        </el-tooltip>
        <el-tooltip content="删除" placement="top" :show-after="300">
          <el-button size="small" circle type="danger" :icon="'Delete'" @click="emit('delete')" />
        </el-tooltip>
      </div>
    </div>

    <div class="picman-tile-meta">
      <div class="picman-tile-name">{{ asset.name }}</div>
      <div class="picman-tile-sub">
        <span v-if="variant === 'file'" class="picman-tile-kind-text">
          {{ ASSET_KIND_LABELS[kind] }}
        </span>
        <span v-if="variant === 'file'" class="picman-tile-dot">·</span>
        <span>{{ detailText }}</span>
        <span class="picman-tile-dot">·</span>
        <span>{{ sizeText }}</span>
      </div>
      <div v-if="asset.tags.length > 0" class="picman-tile-tags">
        <el-tag
          v-for="tag in visibleTags"
          :key="tag.id"
          size="small"
          effect="light"
          :color="tag.color || undefined"
          class="picman-tile-tag"
        >
          {{ tag.name }}
        </el-tag>
        <span v-if="moreTags > 0" class="picman-tile-tagmore">+{{ moreTags }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picman-tile {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  cursor: pointer;
  background: #fff;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  transition: box-shadow 0.2s, transform 0.2s;
}

.picman-tile:hover {
  box-shadow: 0 6px 18px rgb(0 0 0 / 12%);
  transform: translateY(-2px);
}

/*
 * 瀑布流里卡片是 CSS 多列的子项，必须禁止跨列断开，
 * 否则一张卡片会被从中间劈到下一列去。
 */
.picman-tile.is-waterfall {
  break-inside: avoid;
  margin-bottom: 14px;
}

.picman-tile-thumb {
  position: relative;
  overflow: hidden;
  background: repeating-conic-gradient(#f3f4f6 0% 25%, #e9eaec 0% 50%) 50% / 16px 16px;
}

.picman-tile-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.picman-tile-kind {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
}

.picman-tile-kind-note {
  font-size: 12px;
}

.picman-tile-kindbadge {
  position: absolute;
  top: 6px;
  left: 6px;
}

.picman-tile-fav {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  color: #f7ba2a;
  background: rgb(255 255 255 / 88%);
  border-radius: 50%;
}

.picman-tile-missing {
  position: absolute;
  bottom: 6px;
  left: 6px;
  padding: 1px 6px;
  font-size: 11px;
  color: #fff;
  background: var(--el-color-danger);
  border-radius: 4px;
}

.picman-tile-actions {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  gap: 6px;
  justify-content: center;
  padding: 6px;
  background: linear-gradient(to top, rgb(0 0 0 / 55%), transparent);
  opacity: 0;
  transition: opacity 0.2s;
}

.picman-tile:hover .picman-tile-actions,
.picman-tile:focus-within .picman-tile-actions {
  opacity: 1;
}

/* 触屏设备没有 hover，常显操作按钮 */
@media (hover: none) {
  .picman-tile-actions {
    opacity: 1;
  }
}

.picman-tile-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px 10px;
}

.picman-tile-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-tile-sub {
  display: flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.picman-tile-kind-text {
  color: var(--el-text-color-regular);
}

.picman-tile-dot {
  opacity: 0.5;
}

.picman-tile-tags {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-top: 2px;
  overflow: hidden;
}

.picman-tile-tag {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picman-tile-tagmore {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>

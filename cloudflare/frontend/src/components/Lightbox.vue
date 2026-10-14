<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AssetDto } from '../types'
import { rawUrl } from '../api/images'
import { formatBytes } from '../utils/format'

const props = defineProps<{
  /** 当前图库列表（一般为当前分页的结果） */
  images: AssetDto[]
  /** 当前查看的下标 */
  index: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update:index', value: number): void
}>()

const router = useRouter()

/* -------------------- 原图加载 -------------------- */

const loading = ref(true)
const errorCode = ref('')
const errorMessage = ref('')
const objectUrl = ref('')
const natural = ref({ w: 0, h: 0 })

const current = computed<AssetDto | undefined>(() => props.images[props.index])

const displayWidth = computed(() => natural.value.w || current.value?.width || 0)
const displayHeight = computed(() => natural.value.h || current.value?.height || 0)

const isTokenExpired = computed(() => errorCode.value === 'TOKEN_EXPIRED')

let abortController: AbortController | null = null
let loadToken = 0

function releaseObjectUrl(): void {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''
  }
}

/**
 * 原图通过 fetch 拉取：这样后端返回的 503 TOKEN_EXPIRED / 502 UPSTREAM_FAILED
 * 里的真实 message 才能被读到（<img> 的 error 事件拿不到响应体）。
 */
async function loadImage(): Promise<void> {
  const image = current.value
  releaseObjectUrl()
  natural.value = { w: 0, h: 0 }
  errorCode.value = ''
  errorMessage.value = ''
  atFit.value = true
  scale.value = 1
  tx.value = 0
  ty.value = 0

  if (!image) {
    loading.value = false
    errorCode.value = 'NOT_FOUND'
    errorMessage.value = '没有可显示的图片'
    return
  }

  abortController?.abort()
  const controller = new AbortController()
  abortController = controller
  const token = ++loadToken

  loading.value = true
  try {
    const response = await fetch(rawUrl(image.id), {
      credentials: 'include',
      signal: controller.signal
    })
    if (token !== loadToken) return

    if (!response.ok) {
      let code = `HTTP_${response.status}`
      let message = `原图加载失败（HTTP ${response.status}）`
      try {
        const body: unknown = await response.json()
        if (body && typeof body === 'object') {
          const record = body as Record<string, unknown>
          if (typeof record.error === 'string' && record.error) code = record.error
          if (typeof record.message === 'string' && record.message) message = record.message
        }
      } catch {
        /* 响应体不是 JSON，保留默认提示 */
      }
      errorCode.value = code
      errorMessage.value = message
      loading.value = false
      return
    }

    const blob = await response.blob()
    if (token !== loadToken) return
    objectUrl.value = URL.createObjectURL(blob)
    // 必须在这里就结束加载态。
    // 模板里 <img> 是 v-else-if="objectUrl"，被 v-if="loading" 挡在外面；
    // 而 loading 又只在 <img> 的 load 事件里才置 false —— 再等下去就是死锁，
    // 表现就是永远停在「正在加载原图…」。blob 已在本地，解码很快。
    loading.value = false
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return
    if (token !== loadToken) return
    errorCode.value = 'NETWORK_ERROR'
    errorMessage.value = '无法加载原图，请检查网络或后端服务'
    loading.value = false
  }
}

function onImageLoaded(event: Event): void {
  const el = event.target as HTMLImageElement
  natural.value = { w: el.naturalWidth, h: el.naturalHeight }
  loading.value = false
  void nextTick(() => {
    measure()
    applyFit()
  })
}

function onImageError(): void {
  loading.value = false
  errorCode.value = 'DECODE_FAILED'
  errorMessage.value = '图片数据无法解码或已损坏'
}

/* -------------------- 缩放 / 拖动 -------------------- */

const stage = ref<HTMLDivElement | null>(null)
const stageSize = ref({ w: 0, h: 0 })
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)
const atFit = ref(true)

const zoomPercent = computed(() => `${Math.round(scale.value * 100)}%`)

const fitScale = computed(() => {
  const { w, h } = stageSize.value
  const { w: nw, h: nh } = natural.value
  if (!w || !h || !nw || !nh) return 1
  const value = Math.min((w - 40) / nw, (h - 40) / nh)
  return clamp(value, 0.05, 4)
})

const canPan = computed(
  () =>
    natural.value.w * scale.value > stageSize.value.w + 1 ||
    natural.value.h * scale.value > stageSize.value.h + 1
)

const imageStyle = computed(() => ({
  transform: `translate3d(${tx.value}px, ${ty.value}px, 0) scale(${scale.value})`,
  cursor: dragging.value ? 'grabbing' : canPan.value ? 'grab' : 'default'
}))

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function measure(): void {
  const el = stage.value
  if (!el) return
  stageSize.value = { w: el.clientWidth, h: el.clientHeight }
}

function clampOffset(): void {
  const nw = natural.value.w * scale.value
  const nh = natural.value.h * scale.value
  const maxX = Math.max(0, (nw - stageSize.value.w) / 2)
  const maxY = Math.max(0, (nh - stageSize.value.h) / 2)
  tx.value = clamp(tx.value, -maxX, maxX)
  ty.value = clamp(ty.value, -maxY, maxY)
}

function applyFit(): void {
  measure()
  scale.value = fitScale.value
  tx.value = 0
  ty.value = 0
  atFit.value = true
}

function applyActualSize(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  atFit.value = false
  clampOffset()
}

function zoomAt(factor: number, clientX?: number, clientY?: number): void {
  const previous = scale.value
  const next = clamp(previous * factor, 0.05, 8)
  if (next === previous) return

  const el = stage.value
  if (el && clientX !== undefined && clientY !== undefined) {
    const rect = el.getBoundingClientRect()
    const dx = clientX - rect.left - rect.width / 2
    const dy = clientY - rect.top - rect.height / 2
    const ratio = next / previous
    tx.value = dx - ratio * (dx - tx.value)
    ty.value = dy - ratio * (dy - ty.value)
  } else {
    const ratio = next / previous
    tx.value *= ratio
    ty.value *= ratio
  }

  scale.value = next
  atFit.value = false
  clampOffset()
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15
  zoomAt(factor, event.clientX, event.clientY)
}

function onDoubleClick(event: MouseEvent): void {
  if (atFit.value) {
    applyActualSize()
  } else {
    applyFit()
  }
  void event
}

const dragState = { active: false, x: 0, y: 0, pointerId: -1 }

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !canPan.value) return
  // 点在按钮上时不启动拖动，否则指针捕获会吞掉按钮的 click
  const target = event.target as HTMLElement | null
  if (target?.closest('button')) return
  dragState.active = true
  dragState.x = event.clientX
  dragState.y = event.clientY
  dragState.pointerId = event.pointerId
  dragging.value = true
  ;(event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId)
  event.preventDefault()
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState.active) return
  tx.value += event.clientX - dragState.x
  ty.value += event.clientY - dragState.y
  dragState.x = event.clientX
  dragState.y = event.clientY
  clampOffset()
}

function onPointerUp(event: PointerEvent): void {
  if (!dragState.active) return
  dragState.active = false
  dragging.value = false
  ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(dragState.pointerId)
}

/* -------------------- 上一个 / 下一个 -------------------- */

const total = computed(() => props.images.length)
const positionText = computed(() => `${props.index + 1} / ${total.value}`)

function go(delta: number): void {
  if (total.value === 0) return
  const next = (props.index + delta + total.value) % total.value
  emit('update:index', next)
}

function prev(): void {
  go(-1)
}

function next(): void {
  go(1)
}

/* -------------------- 键盘 -------------------- */

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  ) {
    return
  }

  switch (event.key) {
    case 'Escape':
      event.preventDefault()
      emit('close')
      break
    case 'ArrowLeft':
      event.preventDefault()
      prev()
      break
    case 'ArrowRight':
      event.preventDefault()
      next()
      break
    case '+':
    case '=':
      event.preventDefault()
      zoomAt(1.25)
      break
    case '-':
    case '_':
      event.preventDefault()
      zoomAt(1 / 1.25)
      break
    case '0':
      event.preventDefault()
      applyFit()
      break
    case '1':
      event.preventDefault()
      applyActualSize()
      break
    default:
      break
  }
}

/* -------------------- 生命周期 -------------------- */

let resizeObserver: ResizeObserver | null = null

function onResize(): void {
  const wasAtFit = atFit.value
  measure()
  if (wasAtFit) {
    scale.value = fitScale.value
    tx.value = 0
    ty.value = 0
  } else {
    clampOffset()
  }
}

function openBaiduAuth(): void {
  emit('close')
  void router.push('/baidu')
}

onMounted(() => {
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize)
  measure()
  if (typeof ResizeObserver !== 'undefined' && stage.value) {
    resizeObserver = new ResizeObserver(() => onResize())
    resizeObserver.observe(stage.value)
  }
  void loadImage()
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  abortController?.abort()
  loadToken += 1
  releaseObjectUrl()
})

watch(
  () => props.index,
  () => {
    void loadImage()
  }
)
</script>

<template>
  <Teleport to="body">
    <div class="picman-lightbox" role="dialog" aria-modal="true">
      <div class="picman-lightbox-top">
        <div class="picman-lightbox-title">
          <div class="picman-lightbox-name">{{ current?.name || '未知图片' }}</div>
          <div class="picman-lightbox-meta">
            <span>{{ displayWidth || '?' }} × {{ displayHeight || '?' }}</span>
            <span class="picman-sep">·</span>
            <span>{{ current ? formatBytes(current.size) : '-' }}</span>
            <span class="picman-sep">·</span>
            <span>{{ zoomPercent }}</span>
            <span class="picman-sep">·</span>
            <span>{{ positionText }}</span>
          </div>
        </div>
        <div class="picman-lightbox-tools">
          <el-button-group>
            <el-button size="small" @click="applyFit">适应窗口</el-button>
            <el-button size="small" @click="applyActualSize">100%</el-button>
          </el-button-group>
          <el-button-group>
            <el-button size="small" @click="zoomAt(1 / 1.25)">
              <el-icon><ZoomOut /></el-icon>
            </el-button>
            <el-button size="small" @click="zoomAt(1.25)">
              <el-icon><ZoomIn /></el-icon>
            </el-button>
          </el-button-group>
          <el-button size="small" type="primary" plain @click="emit('close')">
            <el-icon><Close /></el-icon>
            关闭 (Esc)
          </el-button>
        </div>
      </div>

      <div
        ref="stage"
        class="picman-lightbox-stage"
        @wheel.prevent="onWheel"
        @dblclick="onDoubleClick"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <div v-if="loading" class="picman-lightbox-loading">
          <el-icon class="is-loading" :size="34"><Loading /></el-icon>
          <span>正在加载原图…</span>
        </div>

        <div v-else-if="errorMessage" class="picman-lightbox-error">
          <el-icon :size="40" color="#f56c6c"><WarningFilled /></el-icon>
          <h3 class="picman-lightbox-error-title">
            {{ isTokenExpired ? '百度网盘授权已失效' : '原图加载失败' }}
          </h3>
          <p class="picman-lightbox-error-message">{{ errorMessage }}</p>
          <p v-if="errorCode" class="picman-lightbox-error-code">错误码：{{ errorCode }}</p>
          <div class="picman-lightbox-error-actions">
            <el-button v-if="isTokenExpired" type="primary" @click="openBaiduAuth">
              前往百度网盘授权页
            </el-button>
            <el-button @click="loadImage">重试</el-button>
            <el-button text @click="emit('close')">关闭</el-button>
          </div>
        </div>

        <img
          v-else-if="objectUrl"
          class="picman-lightbox-img"
          :style="imageStyle"
          :src="objectUrl"
          :alt="current?.name || ''"
          draggable="false"
          @load="onImageLoaded"
          @error="onImageError"
        />

        <button class="picman-lightbox-nav picman-lightbox-nav-prev" title="上一张 (←)" @click.stop="prev">
          <el-icon :size="26"><ArrowLeftBold /></el-icon>
        </button>
        <button class="picman-lightbox-nav picman-lightbox-nav-next" title="下一张 (→)" @click.stop="next">
          <el-icon :size="26"><ArrowRightBold /></el-icon>
        </button>
      </div>

      <div class="picman-lightbox-bottom">
        <span>滚轮缩放 · 拖动平移 · ← → 切换 · Esc 关闭</span>
        <span v-if="current?.path" class="picman-lightbox-path">{{ current.path }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.picman-lightbox {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  background: rgb(12 14 18 / 94%);
  user-select: none;
}

.picman-lightbox-top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  color: #fff;
}

.picman-lightbox-name {
  max-width: 60vw;
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-lightbox-meta {
  margin-top: 2px;
  font-size: 12px;
  color: rgb(255 255 255 / 70%);
}

.picman-sep {
  margin: 0 6px;
}

.picman-lightbox-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.picman-lightbox-stage {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  min-height: 0;
  overflow: hidden;
  touch-action: none;
}

.picman-lightbox-img {
  display: block;
  max-width: none;
  max-height: none;
  transform-origin: center center;
  will-change: transform;
}

.picman-lightbox-loading {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  color: rgb(255 255 255 / 80%);
}

.picman-lightbox-error {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  max-width: 520px;
  padding: 24px;
  color: #fff;
  text-align: center;
}

.picman-lightbox-error-title {
  margin: 0;
  font-size: 17px;
}

.picman-lightbox-error-message {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: rgb(255 255 255 / 82%);
  word-break: break-all;
}

.picman-lightbox-error-code {
  margin: 0;
  font-size: 12px;
  color: rgb(255 255 255 / 55%);
}

.picman-lightbox-error-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.picman-lightbox-nav {
  position: absolute;
  top: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  color: #fff;
  cursor: pointer;
  background: rgb(255 255 255 / 12%);
  border: none;
  border-radius: 50%;
  transform: translateY(-50%);
  transition: background 0.2s;
}

.picman-lightbox-nav:hover {
  background: rgb(255 255 255 / 26%);
}

.picman-lightbox-nav-prev {
  left: 14px;
}

.picman-lightbox-nav-next {
  right: 14px;
}

.picman-lightbox-bottom {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 12px;
  color: rgb(255 255 255 / 60%);
}

.picman-lightbox-path {
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .picman-lightbox-name {
    max-width: 100%;
  }

  .picman-lightbox-tools :deep(.el-button) {
    padding: 6px 8px;
  }

  .picman-lightbox-nav {
    width: 38px;
    height: 38px;
  }

  .picman-lightbox-nav-prev {
    left: 6px;
  }

  .picman-lightbox-nav-next {
    right: 6px;
  }

  .picman-lightbox-path {
    display: none;
  }
}
</style>

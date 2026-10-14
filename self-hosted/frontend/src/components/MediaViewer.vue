<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fileRawUrl } from '../api/files'
import type { AssetDto } from '../types'
import { formatBytes, formatDateTime } from '../utils/format'

const props = defineProps<{
  /** 只包含可播放的条目（视频/音频），由调用方过滤好 */
  assets: AssetDto[]
  index: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'update:index', value: number): void
}>()

const current = computed<AssetDto | null>(() => props.assets[props.index] ?? null)
const isVideo = computed(() => current.value?.kind === 'VIDEO')
const positionText = computed(() => `${props.index + 1} / ${props.assets.length}`)

/**
 * 直接给 <video>/<audio> 一个 /raw 地址，而不是像图片预览那样先 fetch 成 blob。
 * 原因：媒体要能拖进度条，必须让浏览器自己发 Range 请求分片拉取；
 * 换成 blob 就得先把整个文件下载完才能播。
 */
const src = computed(() => (current.value ? fileRawUrl(current.value.id) : ''))

const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
const stageEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const errorCode = ref('')
const errorMessage = ref('')
const duration = ref(0)
const currentTime = ref(0)
const paused = ref(true)

const isTokenExpired = computed(() => errorCode.value === 'TOKEN_EXPIRED')

/* -------------------- 视频：自动隐藏控件 -------------------- */

/**
 * 播放时鼠标不动 3 秒就把标题栏和快捷键提示收起来，移到鼠标再显示。
 * 暂停或出错时始终显示，否则用户会找不到怎么继续。
 */
const chromeVisible = ref(true)
let hideTimer: number | undefined

function nudgeChrome(): void {
  chromeVisible.value = true
  window.clearTimeout(hideTimer)
  if (paused.value || errorMessage.value) return
  hideTimer = window.setTimeout(() => {
    chromeVisible.value = false
  }, 3000)
}

/* -------------------- 媒体事件 -------------------- */

function onLoadedMetadata(): void {
  loading.value = false
  const el = mediaEl.value
  if (el && Number.isFinite(el.duration)) {
    duration.value = el.duration
  }
  nudgeChrome()
}

function onCanPlay(): void {
  loading.value = false
}

function onTimeUpdate(): void {
  currentTime.value = mediaEl.value?.currentTime ?? 0
}

function onPlay(): void {
  paused.value = false
  nudgeChrome()
}

function onPause(): void {
  paused.value = true
  window.clearTimeout(hideTimer)
  chromeVisible.value = true
}

/**
 * <video>/<audio> 的 error 事件拿不到响应体，所以单独发一个只取前 1KB 的
 * Range 请求去读后端返回的 JSON 错误——正常情况会返回 206 而不是错误，
 * 拿不到 JSON 也不会误报。
 */
async function onMediaError(): Promise<void> {
  loading.value = false
  chromeVisible.value = true
  errorCode.value = ''
  errorMessage.value = '媒体加载失败'
  if (!current.value) return
  try {
    const res = await fetch(src.value, { headers: { Range: 'bytes=0-1023' } })
    if (!res.ok) {
      const body = (await res.json()) as { error?: string; message?: string }
      errorCode.value = body.error ?? `HTTP_${res.status}`
      errorMessage.value = body.message ?? errorMessage.value
    }
  } catch {
    // 网络层失败，保留默认提示
  }
}

/* -------------------- 播放控制 -------------------- */

function togglePlay(): void {
  const el = mediaEl.value
  if (!el) return
  if (el.paused) {
    void el.play()
  } else {
    el.pause()
  }
}

function go(step: number): void {
  const next = props.index + step
  if (next < 0 || next >= props.assets.length) return
  reset()
  emit('update:index', next)
}

function reset(): void {
  loading.value = true
  errorCode.value = ''
  errorMessage.value = ''
  duration.value = 0
  currentTime.value = 0
  chromeVisible.value = true
}

/** 视频全屏：对整个舞台而非单个 video 元素，这样自定义控件也能一起进全屏 */
function toggleFullscreen(): void {
  const el = stageEl.value
  if (!el) return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
  } else {
    void el.requestFullscreen?.()
  }
}

function onKeydown(event: KeyboardEvent): void {
  // 焦点在输入框里时不要抢键
  const tag = (event.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return

  if (event.key === 'Escape') {
    // 全屏时 Esc 先退全屏，交给浏览器处理；否则关闭播放器
    if (document.fullscreenElement) return
    event.preventDefault()
    emit('close')
  } else if (event.key === ' ') {
    event.preventDefault()
    togglePlay()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    go(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    go(1)
  }
}

/** 秒 → mm:ss / h:mm:ss */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  nudgeChrome()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.clearTimeout(hideTimer)
  // 关掉时主动暂停，否则音频会在后台继续放
  mediaEl.value?.pause()
})

/** 底部迷你条要占地方，调用方据此给页面留出下边距 */
defineExpose({ isVideo })
</script>

<template>
  <Teleport to="body">
    <!-- ============ 视频：沉浸式全屏 ============ -->
    <div
      v-if="current && isVideo"
      class="picman-media"
      role="dialog"
      aria-modal="true"
      @mousemove="nudgeChrome"
      @touchstart.passive="nudgeChrome"
    >
      <div class="picman-media-top" :class="{ 'is-hidden': !chromeVisible }">
        <div class="picman-media-title">
          <div class="picman-media-name">{{ current.name }}</div>
          <div class="picman-media-meta">
            <span>视频</span>
            <span class="picman-dot">·</span>
            <span>{{ formatBytes(current.size) }}</span>
            <template v-if="duration > 0">
              <span class="picman-dot">·</span>
              <span>{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
            </template>
            <span class="picman-dot">·</span>
            <span>{{ positionText }}</span>
          </div>
        </div>
        <div class="picman-media-tools">
          <button class="picman-tool" :disabled="index <= 0" title="上一个（←）" @click="go(-1)">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <button
            class="picman-tool"
            :disabled="index >= assets.length - 1"
            title="下一个（→）"
            @click="go(1)"
          >
            <el-icon><ArrowRight /></el-icon>
          </button>
          <button class="picman-tool" title="全屏（F）" @click="toggleFullscreen">
            <el-icon><FullScreen /></el-icon>
          </button>
          <button class="picman-tool" title="关闭（Esc）" @click="emit('close')">
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </div>

      <div ref="stageEl" class="picman-media-stage">
        <div v-if="loading && !errorMessage" class="picman-media-loading">
          <el-icon class="is-loading" :size="34"><Loading /></el-icon>
          <span>正在加载…</span>
        </div>

        <div v-if="errorMessage" class="picman-media-error">
          <el-icon :size="40" color="#f56c6c"><WarningFilled /></el-icon>
          <h3 class="picman-media-error-title">
            {{ isTokenExpired ? '百度网盘授权已失效' : '无法播放' }}
          </h3>
          <p class="picman-media-error-message">{{ errorMessage }}</p>
          <p v-if="errorCode" class="picman-media-error-code">错误码：{{ errorCode }}</p>
          <div class="picman-media-error-actions">
            <el-button v-if="isTokenExpired" type="primary" @click="$router.push('/baidu')">
              前往百度网盘授权页
            </el-button>
            <el-button v-else @click="reset">重试</el-button>
            <el-button text @click="emit('close')">关闭</el-button>
          </div>
        </div>

        <!-- key 绑 id：切上/下一个时强制重建元素，浏览器才会重新拉流 -->
        <video
          v-else
          :key="current.id"
          ref="mediaEl"
          class="picman-media-video"
          :src="src"
          controls
          autoplay
          playsinline
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @canplay="onCanPlay"
          @timeupdate="onTimeUpdate"
          @play="onPlay"
          @pause="onPause"
          @error="onMediaError"
        ></video>
      </div>

      <div class="picman-media-hint" :class="{ 'is-hidden': !chromeVisible }">
        空格 播放/暂停 · ← → 切换 · F 全屏 · Esc 关闭
      </div>
    </div>

    <!-- ============ 音频：底部迷你播放条，不挡页面 ============ -->
    <div v-else-if="current" class="picman-audiobar" role="dialog" aria-label="音频播放器">
      <div class="picman-audiobar-cover">
        <el-icon :size="24"><Headset /></el-icon>
      </div>

      <div class="picman-audiobar-info">
        <div class="picman-audiobar-name" :title="current.name">{{ current.name }}</div>
        <div class="picman-audiobar-meta">
          音频 · {{ formatBytes(current.size) }}
          <template v-if="duration > 0">
            <span class="picman-dot">·</span>
            {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
          </template>
          <span class="picman-dot">·</span>
          {{ positionText }}
          <span class="picman-dot">·</span>
          <span class="picman-audiobar-date">{{ formatDateTime(current.serverMtime) }}</span>
        </div>
      </div>

      <div class="picman-audiobar-player">
        <div v-if="errorMessage" class="picman-audiobar-error">
          <el-icon><WarningFilled /></el-icon>
          <span>{{ errorMessage }}</span>
          <el-button v-if="isTokenExpired" size="small" type="primary" @click="$router.push('/baidu')">
            去授权
          </el-button>
          <el-button v-else size="small" @click="reset">重试</el-button>
        </div>
        <audio
          v-else
          :key="current.id"
          ref="mediaEl"
          class="picman-audiobar-audio"
          :src="src"
          controls
          autoplay
          preload="metadata"
          @loadedmetadata="onLoadedMetadata"
          @canplay="onCanPlay"
          @timeupdate="onTimeUpdate"
          @play="onPlay"
          @pause="onPause"
          @error="onMediaError"
        ></audio>
      </div>

      <div class="picman-audiobar-tools">
        <button class="picman-tool is-dark" :disabled="index <= 0" title="上一个（←）" @click="go(-1)">
          <el-icon><ArrowLeft /></el-icon>
        </button>
        <button
          class="picman-tool is-dark"
          :disabled="index >= assets.length - 1"
          title="下一个（→）"
          @click="go(1)"
        >
          <el-icon><ArrowRight /></el-icon>
        </button>
        <button class="picman-tool is-dark" title="关闭（Esc）" @click="emit('close')">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* -------------------- 视频全屏 -------------------- */

.picman-media {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  flex-direction: column;
  background: #000;
}

.picman-media-top {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  /* 用渐变代替生硬的分隔线，让标题浮在画面上方而不是切一刀 */
  background: linear-gradient(to bottom, rgb(0 0 0 / 78%), transparent);
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.picman-media-top.is-hidden {
  pointer-events: none;
  opacity: 0;
  transform: translateY(-8px);
}

.picman-media-title {
  min-width: 0;
  color: #fff;
}

.picman-media-name {
  overflow: hidden;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-media-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 3px;
  font-size: 12px;
  color: rgb(255 255 255 / 62%);
}

.picman-dot {
  opacity: 0.45;
}

.picman-media-tools,
.picman-audiobar-tools {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}

/* 深色媒体界面上的图标按钮：Element Plus 的默认按钮在纯黑上太跳 */
.picman-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: rgb(255 255 255 / 85%);
  cursor: pointer;
  background: rgb(255 255 255 / 10%);
  border: none;
  border-radius: 8px;
  transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.picman-tool:hover:not(:disabled) {
  color: #fff;
  background: rgb(255 255 255 / 22%);
}

.picman-tool:disabled {
  cursor: not-allowed;
  opacity: 0.3;
}

.picman-tool.is-dark {
  color: var(--el-text-color-regular);
  background: var(--el-fill-color);
}

.picman-tool.is-dark:hover:not(:disabled) {
  color: var(--el-color-primary);
  background: var(--el-fill-color-dark);
}

.picman-media-stage {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  min-height: 0;
}

.picman-media-stage:fullscreen {
  background: #000;
}

.picman-media-video {
  width: 100%;
  height: 100%;
  /* 用 contain 让画面按比例填满可用空间，不再留一圈多余的边 */
  object-fit: contain;
  background: #000;
}

.picman-media-loading {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  color: rgb(255 255 255 / 80%);
}

.picman-media-error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  max-width: 520px;
  color: #fff;
  text-align: center;
}

.picman-media-error-title {
  margin: 6px 0 0;
  font-size: 17px;
}

.picman-media-error-message {
  margin: 0;
  font-size: 13px;
  color: rgb(255 255 255 / 78%);
  word-break: break-all;
}

.picman-media-error-code {
  margin: 0;
  font-size: 12px;
  color: rgb(255 255 255 / 50%);
}

.picman-media-error-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.picman-media-hint {
  padding: 10px 18px 14px;
  font-size: 12px;
  color: rgb(255 255 255 / 42%);
  text-align: center;
  background: linear-gradient(to top, rgb(0 0 0 / 65%), transparent);
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.picman-media-hint.is-hidden {
  pointer-events: none;
  opacity: 0;
  transform: translateY(8px);
}

/* -------------------- 音频底部迷你条 -------------------- */

.picman-audiobar {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2500;
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 10px 16px;
  background: var(--el-bg-color-overlay);
  border-top: 1px solid var(--el-border-color-light);
  box-shadow: 0 -6px 20px rgb(0 0 0 / 8%);
}

.picman-audiobar-cover {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  color: #fff;
  background: linear-gradient(135deg, #79bbff, #409eff);
  border-radius: 8px;
}

.picman-audiobar-info {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 34%;
}

.picman-audiobar-name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picman-audiobar-meta {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}

.picman-audiobar-player {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  min-width: 0;
}

.picman-audiobar-audio {
  width: 100%;
  height: 40px;
}

.picman-audiobar-error {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--el-color-danger);
}

@media (max-width: 900px) {
  .picman-audiobar {
    flex-wrap: wrap;
    gap: 8px;
  }

  .picman-audiobar-info {
    max-width: 60%;
  }

  .picman-audiobar-player {
    order: 3;
    flex-basis: 100%;
  }

  .picman-audiobar-date {
    display: none;
  }
}
</style>

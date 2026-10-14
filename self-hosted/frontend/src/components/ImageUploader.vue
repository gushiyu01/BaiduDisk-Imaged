<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, type UploadRawFile, type UploadUserFile } from 'element-plus'
import { uploadImages } from '../api/images'
import { getErrorMessage } from '../api/client'
import type { UploadFailure } from '../types'

const emit = defineEmits<{
  (e: 'uploaded', count: number): void
}>()

const fileList = ref<UploadUserFile[]>([])
const uploading = ref(false)
const progress = ref(0)
const failures = ref<UploadFailure[]>([])
const errorMessage = ref('')
const successCount = ref<number | null>(null)

const MAX_FILES = 50

const pendingCount = computed(() => fileList.value.filter((item) => item.raw !== undefined).length)

const canUpload = computed(() => pendingCount.value > 0 && !uploading.value)

function handleExceed(): void {
  ElMessage.warning(`单次最多上传 ${MAX_FILES} 个文件`)
}

function clearAll(): void {
  fileList.value = []
  failures.value = []
  errorMessage.value = ''
  successCount.value = null
  progress.value = 0
}

async function startUpload(): Promise<void> {
  const files = fileList.value
    .map((item) => item.raw)
    .filter((raw): raw is UploadRawFile => raw !== undefined)

  if (files.length === 0) {
    ElMessage.warning('请先选择图片文件')
    return
  }

  uploading.value = true
  progress.value = 0
  failures.value = []
  errorMessage.value = ''
  successCount.value = null

  try {
    const result = await uploadImages(files, (percent) => {
      progress.value = percent
    })
    const uploaded = Array.isArray(result.uploaded) ? result.uploaded : []
    const failed = Array.isArray(result.failed) ? result.failed : []
    successCount.value = uploaded.length
    failures.value = failed
    if (uploaded.length > 0) {
      ElMessage.success(`成功上传 ${uploaded.length} 张图片`)
    }
    if (failed.length > 0) {
      ElMessage.warning(`${failed.length} 个文件上传失败，详见下方列表`)
    }
    if (uploaded.length === 0 && failed.length === 0) {
      ElMessage.warning('后端未返回任何上传结果')
    }
    fileList.value = []
    if (uploaded.length > 0) {
      emit('uploaded', uploaded.length)
    }
  } catch (err) {
    // 整体失败（如 400 非图片 / 503 未授权 / 507 容量不足）
    errorMessage.value = getErrorMessage(err)
  } finally {
    uploading.value = false
    progress.value = 0
  }
}
</script>

<template>
  <div class="picman-uploader">
    <el-upload
      v-model:file-list="fileList"
      class="picman-upload-drop"
      drag
      multiple
      :auto-upload="false"
      :limit="MAX_FILES"
      accept="image/*"
      :on-exceed="handleExceed"
      :disabled="uploading"
    >
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">把图片拖到这里，或<em>点击选择</em></div>
      <template #tip>
        <div class="el-upload__tip">
          支持多选，一次最多 {{ MAX_FILES }} 个文件；上传后自动写入百度网盘并刷新图库。
        </div>
      </template>
    </el-upload>

    <div class="picman-upload-actions">
      <el-button type="primary" :loading="uploading" :disabled="!canUpload" @click="startUpload">
        开始上传（{{ pendingCount }}）
      </el-button>
      <el-button :disabled="uploading" @click="clearAll">清空</el-button>
      <span class="picman-upload-hint">
        已选择 {{ pendingCount }} 个文件{{ fileList.length > pendingCount ? '（列表含历史记录）' : '' }}
      </span>
    </div>

    <el-progress
      v-if="uploading"
      class="picman-upload-progress"
      :percentage="progress"
      :stroke-width="10"
      striped
      striped-flow
    />

    <el-alert
      v-if="errorMessage"
      class="picman-upload-alert"
      type="error"
      show-icon
      :closable="false"
      title="上传失败"
      :description="errorMessage"
    />

    <el-alert
      v-if="successCount !== null && successCount > 0"
      class="picman-upload-alert"
      type="success"
      show-icon
      :closable="false"
      :title="`成功上传 ${successCount} 张图片`"
    />

    <div v-if="failures.length > 0" class="picman-upload-failures">
      <div class="picman-upload-failures-title">以下文件上传失败：</div>
      <el-table :data="failures" size="small" border max-height="240">
        <el-table-column prop="name" label="文件名" min-width="180" show-overflow-tooltip />
        <el-table-column prop="reason" label="失败原因" min-width="240" show-overflow-tooltip />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.picman-uploader {
  padding: 12px;
  margin-bottom: 12px;
  background: #fff;
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-light);
}

.picman-upload-drop :deep(.el-upload-dragger) {
  padding: 24px 16px;
}

.picman-upload-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
}

.picman-upload-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.picman-upload-progress {
  margin-top: 12px;
}

.picman-upload-alert {
  margin-top: 12px;
}

.picman-upload-failures {
  margin-top: 12px;
}

.picman-upload-failures-title {
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--el-color-danger);
}
</style>

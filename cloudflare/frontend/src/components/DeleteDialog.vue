<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { DeleteAssetResult, DeleteMode, AssetDto } from '../types'
import { deleteImage } from '../api/images'
import { toApiRequestError } from '../api/client'
import { formatBytes } from '../utils/format'

const props = defineProps<{
  modelValue: boolean
  image: AssetDto | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'deleted', result: DeleteAssetResult, mode: DeleteMode): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const mode = ref<DeleteMode>('index')
const submitting = ref(false)
const errorMessage = ref('')

const MODE_OPTIONS: Array<{ value: DeleteMode; label: string; description: string }> = [
  {
    value: 'index',
    label: '只删本地索引（网盘文件保留）',
    description: '仅从 PicMan 的索引中移除，百度网盘上的原文件不会被删除，下次同步可能重新出现。'
  },
  {
    value: 'remote',
    label: '只删网盘文件',
    description: '删除百度网盘上的原文件，本地索引保留并标记为已丢失。'
  },
  {
    value: 'both',
    label: '两边都删',
    description: '同时删除百度网盘原文件与本地索引，不可恢复。'
  }
]

watch(
  () => [props.modelValue, props.image?.id] as const,
  () => {
    if (!props.modelValue) return
    mode.value = 'index'
    errorMessage.value = ''
  },
  { immediate: true }
)

async function submit(): Promise<void> {
  const image = props.image
  if (!image) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await deleteImage(image.id, mode.value)
    ElMessage.success('删除成功')
    emit('deleted', result, mode.value)
    visible.value = false
  } catch (err) {
    errorMessage.value = toApiRequestError(err).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="删除图片" width="560px" :close-on-click-modal="!submitting">
    <div v-if="image" class="picman-delete-body">
      <el-alert
        class="picman-delete-warning"
        type="warning"
        show-icon
        :closable="false"
        title="删除模式需要手动选择，两种删除的结果不同，请确认后操作。"
      />

      <div class="picman-delete-file">
        <div class="picman-delete-name">{{ image.name }}</div>
        <div class="picman-delete-meta">
          {{ image.path }} · {{ formatBytes(image.size) }}
        </div>
      </div>

      <el-radio-group v-model="mode" class="picman-delete-modes">
        <el-radio v-for="option in MODE_OPTIONS" :key="option.value" :value="option.value" class="picman-delete-mode">
          <span class="picman-delete-mode-label">{{ option.label }}</span>
          <span class="picman-delete-mode-desc">
            <code>{{ option.value }}</code> — {{ option.description }}
          </span>
        </el-radio>
      </el-radio-group>

      <el-alert
        v-if="errorMessage"
        type="error"
        show-icon
        :closable="false"
        title="删除失败"
        :description="errorMessage"
      />
    </div>

    <template #footer>
      <el-button :disabled="submitting" @click="visible = false">取消</el-button>
      <el-button type="danger" :loading="submitting" @click="submit">确认删除</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picman-delete-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.picman-delete-file {
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.picman-delete-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  word-break: break-all;
}

.picman-delete-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}

.picman-delete-modes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
}

.picman-delete-mode {
  height: auto;
  padding: 10px 12px;
  margin-right: 0;
  white-space: normal;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.picman-delete-mode :deep(.el-radio__label) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.picman-delete-mode-label {
  font-size: 14px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.picman-delete-mode-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.picman-delete-mode-desc code {
  padding: 0 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--el-color-primary);
  background: var(--el-fill-color);
  border-radius: 3px;
}
</style>

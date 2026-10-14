<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { AssetDto } from '../types'
import { updateImage } from '../api/images'
import { toApiRequestError } from '../api/client'

const props = defineProps<{
  modelValue: boolean
  image: AssetDto | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'renamed', image: AssetDto): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const name = ref('')
const submitting = ref(false)
const errorCode = ref('')
const errorMessage = ref('')

/** 契约：文件名不允许包含 / \ : * ? " < > | */
const ILLEGAL_CHARS = /[/\\:*?"<>|]/

const localError = computed(() => {
  const value = name.value.trim()
  if (!value) return '文件名不能为空'
  if (ILLEGAL_CHARS.test(value)) return '文件名不能包含 / \\ : * ? " < > | 等字符'
  return ''
})

const errorTitle = computed(() => {
  if (errorCode.value === 'CONFLICT' || errorCode.value.startsWith('HTTP_409')) return '文件名冲突'
  if (errorCode.value === 'BAD_NAME' || errorCode.value.startsWith('HTTP_400')) return '文件名不合法'
  return '重命名失败'
})

watch(
  () => [props.modelValue, props.image?.id] as const,
  () => {
    if (!props.modelValue) return
    name.value = props.image?.name ?? ''
    errorCode.value = ''
    errorMessage.value = ''
  },
  { immediate: true }
)

async function submit(): Promise<void> {
  const image = props.image
  if (!image) return
  const value = name.value.trim()
  if (localError.value) {
    errorCode.value = 'BAD_NAME'
    errorMessage.value = localError.value
    return
  }
  if (value === image.name) {
    visible.value = false
    return
  }

  submitting.value = true
  errorCode.value = ''
  errorMessage.value = ''
  try {
    const updated = await updateImage(image.id, { name: value })
    ElMessage.success('重命名成功')
    emit('renamed', updated)
    visible.value = false
  } catch (err) {
    const apiError = toApiRequestError(err)
    errorCode.value = apiError.code
    errorMessage.value = apiError.message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="重命名" width="440px" :close-on-click-modal="!submitting">
    <div v-if="image" class="picman-rename-body">
      <p class="picman-rename-current">
        当前文件名：<span>{{ image.name }}</span>
      </p>
      <el-input
        v-model="name"
        placeholder="请输入新的文件名"
        maxlength="200"
        clearable
        :disabled="submitting"
        @keyup.enter="submit"
      />
      <p class="picman-rename-hint">不能包含 / \ : * ? " &lt; &gt; | 等字符；重命名会同步修改网盘文件。</p>

      <el-alert
        v-if="errorMessage"
        class="picman-rename-alert"
        type="error"
        show-icon
        :closable="false"
        :title="errorTitle"
        :description="errorMessage"
      />
    </div>

    <template #footer>
      <el-button :disabled="submitting" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">确定</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picman-rename-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.picman-rename-current {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.picman-rename-hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.picman-rename-alert {
  margin-top: 4px;
}
</style>

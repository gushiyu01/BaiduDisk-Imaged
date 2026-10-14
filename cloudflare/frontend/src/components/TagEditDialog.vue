<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { AssetDto } from '../types'
import { setImageTags } from '../api/images'
import { toApiRequestError } from '../api/client'
import { useTagsStore } from '../stores/tags'

const props = defineProps<{
  modelValue: boolean
  image: AssetDto | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'saved', image: AssetDto): void
}>()

const tagsStore = useTagsStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const selected = ref<number[]>([])
const submitting = ref(false)
const errorMessage = ref('')

watch(
  () => [props.modelValue, props.image?.id] as const,
  () => {
    if (!props.modelValue) return
    selected.value = (props.image?.tags ?? []).map((tag) => tag.id)
    errorMessage.value = ''
    void tagsStore.ensureLoaded()
  },
  { immediate: true }
)

async function submit(): Promise<void> {
  const image = props.image
  if (!image) return
  submitting.value = true
  errorMessage.value = ''
  try {
    const updated = await setImageTags(image.id, [...selected.value])
    ElMessage.success('标签已更新')
    emit('saved', updated)
    visible.value = false
  } catch (err) {
    errorMessage.value = toApiRequestError(err).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="编辑标签" width="480px" :close-on-click-modal="!submitting">
    <div v-if="image" class="picman-tag-edit">
      <p class="picman-tag-edit-file">{{ image.name }}</p>

      <el-alert
        v-if="tagsStore.error"
        type="error"
        show-icon
        :closable="false"
        title="标签列表加载失败"
        :description="tagsStore.error"
      />

      <el-select
        v-model="selected"
        class="picman-tag-edit-select"
        multiple
        filterable
        collapse-tags
        collapse-tags-tooltip
        :loading="tagsStore.loading"
        placeholder="选择标签（全量覆盖该图片的标签）"
      >
        <el-option
          v-for="tag in tagsStore.tags"
          :key="tag.id"
          :label="tag.name"
          :value="tag.id"
        >
          <span class="picman-tag-option">
            <span class="picman-tag-dot" :style="{ backgroundColor: tag.color || '#409EFF' }" />
            {{ tag.name }}
            <span class="picman-tag-count">({{ tag.count }})</span>
          </span>
        </el-option>
      </el-select>

      <p class="picman-tag-edit-hint">
        保存后会用所选标签全量覆盖该图片的标签；需要新建标签请前往「标签」页面。
      </p>

      <el-alert
        v-if="errorMessage"
        type="error"
        show-icon
        :closable="false"
        title="保存失败"
        :description="errorMessage"
      />
    </div>

    <template #footer>
      <el-button :disabled="submitting" @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.picman-tag-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.picman-tag-edit-file {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

.picman-tag-edit-select {
  width: 100%;
}

.picman-tag-edit-hint {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

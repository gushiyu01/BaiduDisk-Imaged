<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus, Refresh } from '@element-plus/icons-vue'
import type { TagDto } from '../types'
import { toApiRequestError } from '../api/client'
import { useTagsStore } from '../stores/tags'
import { useImagesStore } from '../stores/images'

const tagsStore = useTagsStore()
const imagesStore = useImagesStore()

const PRESET_COLORS = [
  '#409EFF',
  '#67C23A',
  '#E6A23C',
  '#F56C6C',
  '#909399',
  '#9B59B6',
  '#1ABC9C',
  '#34495E'
]

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'edit'>('create')
const editingId = ref<number | null>(null)
const submitting = ref(false)
const formRef = ref<FormInstance>()
const form = reactive({
  name: '',
  color: PRESET_COLORS[0]
})
const formError = ref('')

const dialogTitle = computed(() => (dialogMode.value === 'create' ? '新建标签' : '编辑标签'))

const rules: FormRules = {
  name: [
    { required: true, message: '请输入标签名称', trigger: 'blur' },
    { max: 32, message: '标签名称最多 32 个字符', trigger: 'blur' }
  ]
}

onMounted(() => {
  void tagsStore.fetchTags().catch(() => undefined)
})

function openCreate(): void {
  dialogMode.value = 'create'
  editingId.value = null
  form.name = ''
  form.color = PRESET_COLORS[0]
  formError.value = ''
  dialogVisible.value = true
}

function openEdit(tag: TagDto): void {
  dialogMode.value = 'edit'
  editingId.value = tag.id
  form.name = tag.name
  form.color = tag.color || PRESET_COLORS[0]
  formError.value = ''
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  formError.value = ''
  const payload = { name: form.name.trim(), color: form.color || PRESET_COLORS[0] }
  try {
    if (dialogMode.value === 'create') {
      await tagsStore.addTag(payload)
      ElMessage.success('标签已创建')
    } else if (editingId.value !== null) {
      await tagsStore.editTag(editingId.value, payload)
      ElMessage.success('标签已更新')
    }
    dialogVisible.value = false
    await imagesStore.fetch().catch(() => undefined)
  } catch (err) {
    const apiError = toApiRequestError(err)
    formError.value = apiError.message
  } finally {
    submitting.value = false
  }
}

async function remove(tag: TagDto): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除标签「${tag.name}」吗？删除后会同时解除它与 ${tag.count} 张图片的关联（图片本身不会被删除）。`,
      '删除标签',
      {
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        type: 'warning',
        confirmButtonClass: 'el-button--danger'
      }
    )
  } catch {
    return
  }

  try {
    await tagsStore.removeTag(tag.id)
    ElMessage.success('标签已删除')
    await imagesStore.fetch().catch(() => undefined)
  } catch (err) {
    ElMessage.error(toApiRequestError(err).message)
  }
}
</script>

<template>
  <div class="picman-page">
    <div class="picman-page-head">
      <div>
        <h1 class="picman-page-title">标签</h1>
        <p class="picman-page-subtitle">共 {{ tagsStore.tags.length }} 个标签</p>
      </div>
      <div class="picman-head-actions">
        <el-button :icon="Refresh" :loading="tagsStore.loading" @click="tagsStore.fetchTags()">
          刷新
        </el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建标签</el-button>
      </div>
    </div>

    <el-alert
      v-if="tagsStore.error"
      class="picman-inline-alert"
      type="error"
      show-icon
      :closable="false"
      title="标签列表加载失败"
    >
      <template #default>
        <div class="picman-alert-body">
          <span>{{ tagsStore.error }}</span>
          <el-button size="small" type="primary" @click="tagsStore.fetchTags()">重试</el-button>
        </div>
      </template>
    </el-alert>

    <el-card shadow="never">
      <el-table v-loading="tagsStore.loading" :data="tagsStore.tags" stripe style="width: 100%">
        <el-table-column label="标签" min-width="200">
          <template #default="{ row }">
            <span class="picman-tag-cell">
              <el-tag :color="row.color || undefined" effect="dark" size="default">
                {{ row.name }}
              </el-tag>
            </span>
          </template>
        </el-table-column>
        <el-table-column label="颜色" width="140">
          <template #default="{ row }">
            <span class="picman-color-cell">
              <span class="picman-color-dot" :style="{ backgroundColor: row.color || '#409EFF' }" />
              <code>{{ row.color || '-' }}</code>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="count" label="图片数量" width="120" sortable />
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>

        <template #empty>
          <el-empty description="还没有标签，先新建一个吧" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="420px" :close-on-click-modal="!submitting">
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent="submit">
        <el-form-item label="标签名称" prop="name">
          <el-input v-model="form.name" placeholder="例如：风景" maxlength="32" clearable :disabled="submitting" />
        </el-form-item>
        <el-form-item label="标签颜色">
          <el-color-picker v-model="form.color" :predefine="PRESET_COLORS" :disabled="submitting" />
          <span class="picman-color-value">{{ form.color }}</span>
        </el-form-item>
        <el-alert
          v-if="formError"
          type="error"
          show-icon
          :closable="false"
          title="保存失败"
          :description="formError"
        />
      </el-form>

      <template #footer>
        <el-button :disabled="submitting" @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">保存</el-button>
      </template>
    </el-dialog>
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

.picman-tag-cell {
  display: inline-flex;
  align-items: center;
}

.picman-color-cell {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.picman-color-dot {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1px solid var(--el-border-color);
  border-radius: 3px;
}

.picman-color-value {
  margin-left: 10px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>

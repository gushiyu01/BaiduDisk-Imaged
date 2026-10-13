<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { toApiRequestError } from '../api/client'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const formRef = ref<FormInstance>()
const form = reactive({
  username: '',
  password: ''
})

const submitting = ref(false)
const errorCode = ref('')
const errorMessage = ref('')
const retrying = ref(false)

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

function redirectTarget(): string {
  const value = route.query.redirect
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) {
    return value
  }
  return '/'
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  errorCode.value = ''
  errorMessage.value = ''
  try {
    await auth.login(form.username.trim(), form.password)
    ElMessage.success('登录成功')
    await router.replace(redirectTarget())
  } catch (err) {
    const apiError = toApiRequestError(err)
    errorCode.value = apiError.code
    errorMessage.value = apiError.message
    form.password = ''
  } finally {
    submitting.value = false
  }
}

/** 启动检查失败（后端不可达）时，允许用户重试 */
async function retryBootstrap(): Promise<void> {
  retrying.value = true
  try {
    const initialized = await auth.ensureSetupChecked(true)
    if (initialized === true) {
      ElMessage.success('后端已连接')
    } else if (initialized === false) {
      await router.replace('/setup')
    }
  } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div class="picman-auth-wrap">
    <el-card class="picman-auth-card" shadow="always">
      <div class="picman-auth-head">
        <span class="picman-auth-mark">P</span>
        <h1 class="picman-auth-title">PicMan</h1>
        <p class="picman-auth-sub">百度网盘个人图片管理器</p>
      </div>

      <el-alert
        v-if="auth.setupCheckError"
        class="picman-auth-alert"
        type="warning"
        show-icon
        :closable="false"
        title="无法获取后端初始化状态"
      >
        <template #default>
          <div class="picman-auth-alert-body">
            <span>{{ auth.setupCheckError }}</span>
            <el-button size="small" :loading="retrying" @click="retryBootstrap">重试连接</el-button>
          </div>
        </template>
      </el-alert>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="submit"
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            autocomplete="username"
            clearable
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            show-password
            :disabled="submitting"
            @keyup.enter="submit"
          />
        </el-form-item>

        <el-alert
          v-if="errorMessage"
          class="picman-auth-alert"
          type="error"
          show-icon
          :closable="false"
          :title="errorCode === 'BAD_CREDENTIALS' || errorCode === 'HTTP_401' ? '登录失败' : '登录失败'"
          :description="errorMessage"
        />

        <el-button
          class="picman-auth-submit"
          type="primary"
          size="large"
          :loading="submitting"
          @click="submit"
        >
          登录
        </el-button>
      </el-form>

      <p class="picman-auth-foot">
        还没有管理员账号？
        <RouterLink to="/setup">前往初始化</RouterLink>
      </p>
    </el-card>
  </div>
</template>

<style scoped>
.picman-auth-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
  background: linear-gradient(135deg, #eef4ff, #f7f9fc 45%, #eef7f1);
}

.picman-auth-card {
  width: 100%;
  max-width: 420px;
  border-radius: 12px;
}

.picman-auth-head {
  margin-bottom: 18px;
  text-align: center;
}

.picman-auth-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  margin-bottom: 10px;
  font-size: 22px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #409eff, #2f7fe0);
  border-radius: 12px;
}

.picman-auth-title {
  margin: 0;
  font-size: 20px;
}

.picman-auth-sub {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}

.picman-auth-alert {
  margin-bottom: 14px;
}

.picman-auth-alert-body {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.picman-auth-submit {
  width: 100%;
}

.picman-auth-foot {
  margin: 16px 0 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
</style>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { initSetup } from '../api/setup'
import { toApiRequestError } from '../api/client'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const auth = useAuthStore()

const formRef = ref<FormInstance>()
const form = reactive({
  username: '',
  password: '',
  confirm: ''
})

const submitting = ref(false)
const errorCode = ref('')
const errorMessage = ref('')

const rules: FormRules = {
  username: [
    { required: true, message: '请输入管理员用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '用户名长度需为 3 - 32 位', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' }
  ],
  confirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_rule, value, callback) => {
        if (value !== form.password) {
          callback(new Error('两次输入的密码不一致'))
          return
        }
        callback()
      },
      trigger: ['blur', 'change']
    }
  ]
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  submitting.value = true
  errorCode.value = ''
  errorMessage.value = ''
  try {
    const result = await initSetup({
      username: form.username.trim(),
      password: form.password
    })
    auth.initialized = true
    ElMessage.success(`管理员 ${result.username} 创建成功，请登录`)
    await router.replace('/login')
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
  <div class="picman-auth-wrap">
    <el-card class="picman-auth-card" shadow="always">
      <div class="picman-auth-head">
        <span class="picman-auth-mark">P</span>
        <h1 class="picman-auth-title">初始化 PicMan</h1>
        <p class="picman-auth-sub">首次使用，请先创建管理员账号</p>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        @submit.prevent="submit"
      >
        <el-form-item label="管理员用户名" prop="username">
          <el-input
            v-model="form.username"
            placeholder="例如 admin"
            autocomplete="username"
            clearable
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="至少 8 位"
            autocomplete="new-password"
            show-password
            :disabled="submitting"
          />
        </el-form-item>

        <el-form-item label="确认密码" prop="confirm">
          <el-input
            v-model="form.confirm"
            type="password"
            placeholder="请再次输入密码"
            autocomplete="new-password"
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
          :title="errorCode === 'HTTP_409' ? '系统已初始化' : '初始化失败'"
          :description="errorMessage"
        />

        <el-button
          class="picman-auth-submit"
          type="primary"
          size="large"
          :loading="submitting"
          @click="submit"
        >
          创建管理员并继续
        </el-button>
      </el-form>

      <p class="picman-auth-foot">
        已经初始化过？
        <RouterLink to="/login">直接登录</RouterLink>
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

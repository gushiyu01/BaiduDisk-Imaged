import { ref } from 'vue'
import { defineStore } from 'pinia'
import * as authApi from '../api/auth'
import { getSetupStatus } from '../api/setup'

export const useAuthStore = defineStore('auth', () => {
  /** 当前登录用户名，null 表示未登录 */
  const username = ref<string | null>(null)
  /** GET /api/setup/status 的结果，null 表示尚未检查 */
  const initialized = ref<boolean | null>(null)
  /** 启动检查失败时的提示（后端不可达等） */
  const setupCheckError = ref('')

  const busy = ref(false)

  /** 启动时只查一次初始化状态；后续路由守卫直接读缓存 */
  async function ensureSetupChecked(force = false): Promise<boolean | null> {
    if (!force && initialized.value !== null) return initialized.value
    try {
      const status = await getSetupStatus()
      initialized.value = status.initialized
      setupCheckError.value = ''
    } catch (err) {
      initialized.value = null
      setupCheckError.value = err instanceof Error ? err.message : '无法获取初始化状态'
    }
    return initialized.value
  }

  async function fetchMe(): Promise<string> {
    const user = await authApi.me()
    username.value = user.username
    return user.username
  }

  async function login(user: string, password: string): Promise<string> {
    busy.value = true
    try {
      const res = await authApi.login({ username: user, password })
      username.value = res.username
      return res.username
    } finally {
      busy.value = false
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout()
    } finally {
      username.value = null
    }
  }

  return {
    username,
    initialized,
    setupCheckError,
    busy,
    ensureSetupChecked,
    fetchMe,
    login,
    logout
  }
})

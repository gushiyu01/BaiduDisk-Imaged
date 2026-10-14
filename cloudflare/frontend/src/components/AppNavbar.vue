<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuthStore } from '../stores/auth'
import { getErrorMessage } from '../api/client'
import ChangePasswordDialog from './ChangePasswordDialog.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const loggingOut = ref(false)
const passwordVisible = ref(false)

const activePath = computed(() => route.path)

const navigation = [
  { path: '/', label: '图库' },
  { path: '/files', label: '文件库' },
  { path: '/tags', label: '标签' },
  { path: '/baidu', label: '百度网盘' }
]

async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    return
  }
  loggingOut.value = true
  try {
    await auth.logout()
    ElMessage.success('已退出登录')
    await router.push('/login')
  } catch (err) {
    ElMessage.error(getErrorMessage(err))
  } finally {
    loggingOut.value = false
  }
}
</script>

<template>
  <header class="picman-navbar">
    <div class="picman-navbar-inner">
      <RouterLink class="picman-brand" to="/">
        <span class="picman-brand-mark">P</span>
        <span class="picman-brand-text">
          <strong>PicMan</strong>
          <small>百度网盘图片管家</small>
        </span>
      </RouterLink>

      <el-menu
        class="picman-navbar-menu"
        mode="horizontal"
        :ellipsis="false"
        :default-active="activePath"
        router
      >
        <el-menu-item v-for="item in navigation" :key="item.path" :index="item.path">
          {{ item.label }}
        </el-menu-item>
      </el-menu>

      <div class="picman-navbar-right">
        <el-dropdown trigger="click">
          <span class="picman-user">
            <el-icon><UserFilled /></el-icon>
            <span class="picman-user-name">{{ auth.username || '未登录' }}</span>
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="router.push('/baidu')">百度网盘授权</el-dropdown-item>
            <el-dropdown-item @click="passwordVisible = true">修改密码</el-dropdown-item>
              <el-dropdown-item divided :disabled="loggingOut" @click="handleLogout">
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button
          class="picman-logout-btn"
          size="small"
          :loading="loggingOut"
          @click="handleLogout"
        >
          退出登录
        </el-button>
      </div>
    </div>

    <ChangePasswordDialog v-model="passwordVisible" />
  </header>
</template>

<style scoped>
.picman-navbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: #fff;
  border-bottom: 1px solid var(--el-border-color-light);
}

.picman-navbar-inner {
  display: flex;
  gap: 16px;
  align-items: center;
  max-width: 1440px;
  height: var(--picman-navbar-height);
  padding: 0 16px;
  margin: 0 auto;
}

.picman-brand {
  display: flex;
  gap: 8px;
  align-items: center;
  flex: 0 0 auto;
  color: var(--el-text-color-primary);
}

.picman-brand-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #409eff, #2f7fe0);
  border-radius: 8px;
}

.picman-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
}

.picman-brand-text strong {
  font-size: 15px;
}

.picman-brand-text small {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.picman-navbar-menu {
  flex: 1 1 auto;
  min-width: 0;
  border-bottom: none !important;
}

.picman-navbar-right {
  display: flex;
  gap: 10px;
  align-items: center;
  flex: 0 0 auto;
}

.picman-user {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 14px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  outline: none;
}

.picman-user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .picman-navbar-inner {
    gap: 8px;
    padding: 0 10px;
  }

  .picman-brand-text small,
  .picman-user-name,
  .picman-logout-btn {
    display: none;
  }

  .picman-brand-text strong {
    display: none;
  }
}
</style>

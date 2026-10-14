import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/setup',
    name: 'setup',
    component: () => import('../views/SetupView.vue'),
    meta: { public: true, plain: true, title: '初始化' }
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, plain: true, title: '登录' }
  },
  {
    path: '/',
    name: 'gallery',
    component: () => import('../views/GalleryView.vue'),
    meta: { title: '图库' }
  },
  {
    path: '/files',
    name: 'files',
    component: () => import('../views/FilesView.vue'),
    meta: { title: '文件库' }
  },
  {
    path: '/tags',
    name: 'tags',
    component: () => import('../views/TagsView.vue'),
    meta: { title: '标签' }
  },
  {
    path: '/baidu',
    name: 'baidu',
    component: () => import('../views/BaiduView.vue'),
    meta: { title: '百度网盘' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  // 启动时只检查一次初始化状态
  if (auth.initialized === null) {
    await auth.ensureSetupChecked()
  }

  // 后端不可达：放行到登录页，由登录页展示真实错误
  if (auth.initialized === null) {
    return to.path === '/login' ? true : { path: '/login', replace: true }
  }

  // 还没初始化 → 只能待在初始化页
  if (auth.initialized === false) {
    return to.path === '/setup' ? true : { path: '/setup', replace: true }
  }

  // 已初始化 → 不再需要初始化页
  if (to.path === '/setup') {
    return { path: auth.username ? '/' : '/login', replace: true }
  }

  if (to.meta.public === true) return true

  if (auth.username) return true

  try {
    await auth.fetchMe()
    return true
  } catch {
    return { path: '/login', query: { redirect: to.fullPath }, replace: true }
  }
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : ''
  document.title = title ? `${title} · PicMan` : 'PicMan · 百度网盘图片管家'
})

export default router

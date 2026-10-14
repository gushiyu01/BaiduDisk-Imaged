<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppNavbar from './components/AppNavbar.vue'

const route = useRoute()
// 初始导航（含 setup/登录态检查）完成前 matched 为空，此时不渲染顶栏，避免闪烁
const showNavbar = computed(() => route.matched.length > 0 && route.meta.public !== true)
</script>

<template>
  <div class="app-shell">
    <AppNavbar v-if="showNavbar" />
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.app-main {
  flex: 1 1 auto;
  overflow-x: hidden;
}
</style>

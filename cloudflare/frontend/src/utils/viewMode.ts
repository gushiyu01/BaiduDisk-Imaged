import { ref, watch, type Ref } from 'vue'

/**
 * 视图模式的本地记忆。
 * 用户在文件库里选了瀑布流，刷新后应该还是瀑布流。
 */
export function usePersistedViewMode<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): Ref<T> {
  let initial: T = fallback
  try {
    const stored = localStorage.getItem(key)
    if (stored && (allowed as readonly string[]).includes(stored)) {
      initial = stored as T
    }
  } catch {
    // 隐私模式 / 禁用存储：用默认值，不打扰用户
  }

  const mode = ref(initial) as Ref<T>
  watch(mode, (value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // 存不下就算了，不影响功能
    }
  })
  return mode
}

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { getAccessStatus, subscribeAccess } from './access'
import { settings } from './settings'
import { store } from './store'

/** 订阅全局应用状态 */
export function useAppState() {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/** 当前是否为只读会话（只读密码或会话失效） */
export function useReadOnly() {
  return useSyncExternalStore(
    subscribeAccess,
    useCallback(() => {
      const status = getAccessStatus()
      return status ? !status.canEdit : false
    }, []),
    () => false,
  )
}

/** 订阅单个设置项，返回 [value, setValue] */
export function useSetting<T extends boolean | number | string>(key: string) {
  const value = useSyncExternalStore(
    settings.subscribe,
    useCallback(() => settings.get<T>(key), [key]),
    useCallback(() => settings.get<T>(key), [key]),
  )
  return [value, useCallback((next: T) => settings.set(key, next), [key])] as const
}

/** 订阅设置变化的版本号（用于依赖大量设置项的组件） */
export function useSettingsVersion() {
  return useSyncExternalStore(
    settings.subscribe,
    useCallback(() => JSON.stringify(settings.getAll()), []),
    useCallback(() => '', []),
  )
}

/**
 * 瀑布流布局：为每个网格项计算需要跨越的行数。
 * 与 Classworks 的 grid-masonry 一致，保证卡片按行主序排列且高度自适应。
 */
export function useMasonry(deps: unknown[] = []) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const reflow = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const styles = window.getComputedStyle(container)
    const rowHeight = parseFloat(styles.getPropertyValue('grid-auto-rows')) || 8
    const rowGap = parseFloat(styles.getPropertyValue('row-gap')) || 0
    const items = Array.from(container.children) as HTMLElement[]
    for (const item of items) {
      item.style.gridRowEnd = 'auto'
      const height = item.getBoundingClientRect().height
      const span = Math.ceil((height + rowGap) / (rowHeight + rowGap))
      item.style.gridRowEnd = `span ${span}`
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(reflow)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    Array.from(container.children).forEach((child) => observer.observe(child))
    schedule()

    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reflow, ...deps])

  return { containerRef, reflow }
}

/** 媒体查询 */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const mql = window.matchMedia(query)
        mql.addEventListener('change', onChange)
        return () => mql.removeEventListener('change', onChange)
      },
      [query],
    ),
    useCallback(() => window.matchMedia(query).matches, [query]),
    () => false,
  )
}

/** 点击元素外部触发回调 */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  handler: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref.current
      if (!el || el.contains(event.target as Node)) return
      handler()
    }
    document.addEventListener('mousedown', listener)
    document.addEventListener('touchstart', listener)
    return () => {
      document.removeEventListener('mousedown', listener)
      document.removeEventListener('touchstart', listener)
    }
  }, [ref, handler, enabled])
}

/** 每秒刷新的当前时间 */
export function useNow(intervalMs = 1000) {
  const now = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        const timer = setInterval(onChange, intervalMs)
        return () => clearInterval(timer)
      },
      [intervalMs],
    ),
    () => Math.floor(Date.now() / intervalMs),
    () => 0,
  )
  return new Date(now * intervalMs)
}

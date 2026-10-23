import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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

export type PresencePhase = 'stable' | 'enter' | 'leave'

export interface PresenceEntry<T> {
  key: string
  item: T
  phase: PresencePhase
}

/**
 * 列表进出场（对齐 Vue TransitionGroup 的 enter / leave）：
 * 新条目标记为 enter，移除条目继续渲染到动画结束再删除。
 */
export function usePresence<T>(
  items: T[],
  keyOf: (item: T) => string,
  timing: { enter: number; leave: number },
) {
  const keyOfRef = useRef(keyOf)
  keyOfRef.current = keyOf
  const [entries, setEntries] = useState<PresenceEntry<T>[]>(() =>
    items.map((item) => ({ key: keyOf(item), item, phase: 'stable' })),
  )
  const leaveTimers = useRef(new Map<string, number>())

  useEffect(() => {
    const keyFn = keyOfRef.current
    setEntries((previous) => {
      const previousMap = new Map(previous.map((entry) => [entry.key, entry]))
      const nextKeys = new Set(items.map(keyFn))
      const next = items.map<PresenceEntry<T>>((item) => {
        const key = keyFn(item)
        const existing = previousMap.get(key)
        return existing
          ? { key, item, phase: existing.phase === 'leave' ? 'enter' : existing.phase }
          : { key, item, phase: 'enter' }
      })
      const leaving = previous
        .filter((entry) => !nextKeys.has(entry.key))
        .map<PresenceEntry<T>>((entry) =>
          entry.phase === 'leave' ? entry : { ...entry, phase: 'leave' },
        )
      // 让离场条目停留在原位置附近，避免删除卡片时先跳到末尾再淡出
      const withLeaving = [...next]
      for (const entry of leaving) {
        const oldIndex = previous.findIndex((item) => item.key === entry.key)
        withLeaving.splice(Math.min(Math.max(oldIndex, 0), withLeaving.length), 0, entry)
      }
      return withLeaving
    })
  }, [items])

  useEffect(() => {
    for (const [key, timer] of leaveTimers.current) {
      const entry = entries.find((item) => item.key === key)
      if (!entry || entry.phase !== 'leave') {
        window.clearTimeout(timer)
        leaveTimers.current.delete(key)
      }
    }
    for (const entry of entries) {
      if (entry.phase !== 'leave' || leaveTimers.current.has(entry.key)) continue
      const timer = window.setTimeout(() => {
        leaveTimers.current.delete(entry.key)
        setEntries((previous) =>
          previous.filter((item) => !(item.key === entry.key && item.phase === 'leave')),
        )
      }, timing.leave)
      leaveTimers.current.set(entry.key, timer)
    }
  }, [entries, timing.leave])

  useEffect(() => {
    if (!entries.some((entry) => entry.phase === 'enter')) return
    const timer = window.setTimeout(() => {
      setEntries((previous) =>
        previous.map((entry) => (entry.phase === 'enter' ? { ...entry, phase: 'stable' } : entry)),
      )
    }, timing.enter)
    return () => window.clearTimeout(timer)
  }, [entries, timing.enter])

  useEffect(
    () => () => {
      for (const timer of leaveTimers.current.values()) window.clearTimeout(timer)
      leaveTimers.current.clear()
    },
    [],
  )

  return entries
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

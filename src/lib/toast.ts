/** 轻量全局提示。语义对齐 Classworks 的 message 工具：success / error / warning / info。 */

import { messages } from './messages'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  title: string
  message?: string
}

let seq = 0
let items: ToastItem[] = []
const listeners = new Set<() => void>()

function emit() {
  items = [...items]
  listeners.forEach((fn) => fn())
}

export function subscribeToast(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getToasts() {
  return items
}

export function dismissToast(id: number) {
  items = items.filter((item) => item.id !== id)
  emit()
}

function push(kind: ToastKind, title: string, message?: string) {
  const id = ++seq
  items = [...items, { id, kind, title, message }].slice(-4)
  messages.add(kind, title, message)
  emit()
  setTimeout(() => dismissToast(id), 2000)
  return id
}

export const toast = {
  success: (title: string, message?: string) => push('success', title, message),
  error: (title: string, message?: string) => push('error', title, message),
  warning: (title: string, message?: string) => push('warning', title, message),
  info: (title: string, message?: string) => push('info', title, message),
}

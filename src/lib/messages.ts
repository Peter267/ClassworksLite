/** 消息中心：与上游 message.js / MessageLog.vue 对齐的消息历史与抽屉状态。 */

export type MessageKind = 'success' | 'error' | 'warning' | 'info'

export interface MessageItem {
  id: number
  kind: MessageKind
  title: string
  message?: string
  timestamp: number
}

const STORAGE_KEY = 'classworks-message-log'
const MAX_ITEMS = 100

function readStorage(): MessageItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MessageItem[]) : []
  } catch {
    return []
  }
}

function writeStorage(items: MessageItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)))
  } catch {
    /* ignore */
  }
}

class MessageStore {
  private items: MessageItem[] = readStorage()
  private listeners = new Set<() => void>()
  private seq = this.items[0]?.id ?? 0

  unread = 0
  drawerOpen = false

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.listeners.forEach((fn) => fn())
  }

  getItems() {
    return this.items
  }

  add(kind: MessageKind, title: string, message?: string) {
    const item: MessageItem = {
      id: ++this.seq,
      kind,
      title,
      message: message?.slice(0, 500),
      timestamp: Date.now(),
    }
    this.items = [item, ...this.items].slice(0, MAX_ITEMS)
    this.unread += 1
    writeStorage(this.items)
    this.emit()
  }

  open() {
    this.drawerOpen = true
    this.unread = 0
    this.emit()
  }

  close() {
    this.drawerOpen = false
    this.emit()
  }

  remove(id: number) {
    this.items = this.items.filter((item) => item.id !== id)
    writeStorage(this.items)
    this.emit()
  }

  clear() {
    this.items = []
    this.unread = 0
    writeStorage(this.items)
    this.emit()
  }
}

export const messages = new MessageStore()

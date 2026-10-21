/**
 * 登录失败限流：按 IP 哈希计数，连续失败达到上限后临时锁定。
 *
 * 状态保存在 Backend 的保留键里，与管理后台、站点访问密码共用同一套逻辑。
 */
import type { Backend } from './kv-core'

const DEFAULT_LIMIT = 5
const DEFAULT_LOCK_MS = 10 * 60 * 1000
const MAX_ENTRIES = 200

interface GuardEntry {
  n: number
  first: number
  until: number
}

type GuardMap = Record<string, GuardEntry>

export interface LoginGuard {
  /** 返回剩余锁定分钟数，0 表示未锁定 */
  locked(ip: string): Promise<number>
  /** 记录一次失败，返回本次失败后剩余的锁定分钟数 */
  fail(ip: string): Promise<number>
  /** 登录成功后清除该 IP 的失败记录 */
  reset(ip: string): Promise<void>
}

const encoder = new TextEncoder()

/** 同一实例内串行化读改写，降低并发失败尝试被少计的概率 */
let guardQueue: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = guardQueue.then(task, task)
  guardQueue = next.catch(() => undefined)
  return next
}

async function ipKey(ip: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(ip)))
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function readGuard(backend: Backend, storageKey: string): Promise<GuardMap> {
  try {
    const raw = await backend.read(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as GuardMap) : {}
  } catch {
    return {}
  }
}

async function writeGuard(
  backend: Backend,
  storageKey: string,
  guard: GuardMap,
): Promise<void> {
  try {
    const entries = Object.entries(guard)
      .filter(([, entry]) => entry && typeof entry.until === 'number')
      .sort((a, b) => b[1].first - a[1].first)
      .slice(0, MAX_ENTRIES)
    await backend.write(storageKey, JSON.stringify(Object.fromEntries(entries)))
  } catch (err) {
    console.warn('[guard] 登录限流状态写入失败', err)
  }
}

export function createLoginGuard(
  backend: Backend,
  storageKey: string,
  options: { limit?: number; lockMs?: number } = {},
): LoginGuard {
  const limit = options.limit ?? DEFAULT_LIMIT
  const lockMs = options.lockMs ?? DEFAULT_LOCK_MS

  return {
    async locked(ip) {
      const key = await ipKey(ip)
      const guard = await readGuard(backend, storageKey)
      const entry = guard[key]
      if (!entry || entry.until <= Date.now()) return 0
      return Math.ceil((entry.until - Date.now()) / 60_000)
    },

    async fail(ip) {
      return serialize(async () => {
        const key = await ipKey(ip)
        const guard = await readGuard(backend, storageKey)
        const now = Date.now()
        const current = guard[key]
        const next: GuardEntry =
          current && now - current.first < lockMs ? current : { n: 0, first: now, until: 0 }
        next.n += 1
        if (next.n >= limit) next.until = now + lockMs
        guard[key] = next
        await writeGuard(backend, storageKey, guard)
        return next.until > now ? Math.ceil((next.until - now) / 60_000) : 0
      })
    },

    async reset(ip) {
      return serialize(async () => {
        const key = await ipKey(ip)
        const guard = await readGuard(backend, storageKey)
        if (!guard[key]) return
        delete guard[key]
        await writeGuard(backend, storageKey, guard)
      })
    },
  }
}

/**
 * 数据客户端。
 *
 * 两种模式共用同一套接口：
 *  - local：直接读写 IndexedDB，完全离线可用。
 *  - cloud：读写部署在 Serverless 平台上的 /api/kv；同时把结果写进 IndexedDB 做缓存，
 *           网络不可用时降级为「本地暂存 + 待同步」，恢复后自动补传。
 *
 * 服务端契约（见 worker/index.ts）：
 *   GET    /api/kv?key=K        -> { key, value, updatedAt } | 404
 *   GET    /api/kv?prefix=P     -> { keys: [{ key, updatedAt }] }
 *   PUT    /api/kv  { key, value } -> { key, updatedAt }
 *   DELETE /api/kv?key=K        -> { ok: true }
 *   鉴权：Authorization: Bearer <SITE_TOKEN>
 */

import { cacheAll, cacheDelete, cacheGet, cacheSet } from './cache'
import { getSetting } from './settings'
import type { KVEntry, ProviderMode } from './types'

export class AuthError extends Error {
  constructor(message = '访问令牌无效') {
    super(message)
    this.name = 'AuthError'
  }
}

export class NetworkError extends Error {
  constructor(message = '网络不可用') {
    super(message)
    this.name = 'NetworkError'
  }
}

export interface KVClient {
  readonly mode: ProviderMode
  get<T>(key: string): Promise<KVEntry<T> | null>
  set<T>(key: string, value: T): Promise<{ entry: KVEntry<T>; queued: boolean }>
  remove(key: string): Promise<{ queued: boolean }>
  list(prefix?: string): Promise<{ key: string; updatedAt: number }[]>
  /** 补传离线期间的写入，返回成功条数 */
  flush(): Promise<number>
  /** 未同步条数 */
  pendingCount(): Promise<number>
}

/* ------------------------------------------------------------------ */
/* 本地客户端                                                          */
/* ------------------------------------------------------------------ */

export class LocalClient implements KVClient {
  readonly mode = 'local' as const

  async get<T>(key: string): Promise<KVEntry<T> | null> {
    const record = await cacheGet(key)
    if (!record) return null
    return { value: record.value as T, updatedAt: record.updatedAt }
  }

  async set<T>(key: string, value: T) {
    const entry: KVEntry<T> = { value, updatedAt: Date.now() }
    await cacheSet({ key, value, updatedAt: entry.updatedAt })
    return { entry, queued: false }
  }

  async remove(key: string) {
    await cacheDelete(key)
    return { queued: false }
  }

  async list(prefix = '') {
    const all = await cacheAll()
    return all
      .filter((record) => record.key.startsWith(prefix))
      .map((record) => ({ key: record.key, updatedAt: record.updatedAt }))
  }

  async flush() {
    return 0
  }

  async pendingCount() {
    const all = await cacheAll()
    return all.filter((record) => record.pending).length
  }
}

/* ------------------------------------------------------------------ */
/* 云端客户端                                                          */
/* ------------------------------------------------------------------ */

const TIMEOUT = 9000

function apiBase(): string {
  const configured = getSetting('server.domain').trim()
  if (!configured) return ''
  return configured.replace(/\/+$/, '')
}

function authHeaders(): Record<string, string> {
  const token = getSetting('server.siteKey').trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...authHeaders(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    if (response.status === 401 || response.status === 403) throw new AuthError()
    return response
  } catch (err) {
    if (err instanceof AuthError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NetworkError('请求超时')
    }
    throw new NetworkError(err instanceof Error ? err.message : '网络不可用')
  } finally {
    clearTimeout(timer)
  }
}

export class CloudClient implements KVClient {
  readonly mode = 'cloud' as const

  async get<T>(key: string): Promise<KVEntry<T> | null> {
    const cached = await cacheGet(key)
    // 本地有尚未上传的改动时，必须优先返回本地副本：
    // 否则启动/刷新会先读到云端旧值，把离线改动覆盖掉（D1）。
    if (cached?.pending) {
      if (cached.value === null) return null
      return {
        value: cached.value as T,
        updatedAt: cached.updatedAt,
        stale: true,
        pending: true,
      }
    }
    try {
      const response = await request(`/api/kv?key=${encodeURIComponent(key)}`)
      if (response.status === 404) {
        // 云端已删除：清理本地缓存，避免展示幽灵数据
        if (cached) await cacheDelete(key)
        return null
      }
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      const data = (await response.json()) as { value: T; updatedAt: number }
      try {
        await cacheSet({ key, value: data.value, updatedAt: data.updatedAt })
      } catch (err) {
        console.warn('[kv] 云端读取成功但本地缓存写入失败', err)
      }
      return { value: data.value, updatedAt: data.updatedAt }
    } catch (err) {
      if (err instanceof AuthError) throw err
      if (cached) {
        return {
          value: cached.value as T,
          updatedAt: cached.updatedAt,
          stale: true,
          pending: cached.pending,
        }
      }
      return null
    }
  }

  async set<T>(key: string, value: T) {
    const localUpdatedAt = Date.now()
    try {
      const response = await request('/api/kv', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      })
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      const data = (await response.json()) as { updatedAt: number }
      const entry: KVEntry<T> = { value, updatedAt: data.updatedAt }
      try {
        await cacheSet({ key, value, updatedAt: data.updatedAt })
      } catch (err) {
        console.warn('[kv] 云端写入成功但本地缓存写入失败', err)
      }
      return { entry, queued: false }
    } catch (err) {
      if (err instanceof AuthError) throw err
      // 离线降级：写入本地并标记待同步（写不进去会抛错，避免谎报成功）
      await cacheSet({ key, value, updatedAt: localUpdatedAt, pending: true })
      return { entry: { value, updatedAt: localUpdatedAt, pending: true }, queued: true }
    }
  }

  async remove(key: string) {
    try {
      const response = await request(`/api/kv?key=${encodeURIComponent(key)}`, { method: 'DELETE' })
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      await cacheDelete(key)
      return { queued: false }
    } catch (err) {
      if (err instanceof AuthError) throw err
      await cacheSet({ key, value: null, updatedAt: Date.now(), pending: true })
      return { queued: true }
    }
  }

  async list(prefix = '') {
    try {
      const response = await request(`/api/kv?prefix=${encodeURIComponent(prefix)}`)
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      const data = (await response.json()) as { keys: { key: string; updatedAt: number }[] }
      return data.keys
    } catch (err) {
      if (err instanceof AuthError) throw err
      const all = await cacheAll()
      return all
        .filter((record) => record.key.startsWith(prefix))
        .map((record) => ({ key: record.key, updatedAt: record.updatedAt }))
    }
  }

  async flush(): Promise<number> {
    const all = await cacheAll()
    const pending = all.filter((record) => record.pending)
    let done = 0
    for (const record of pending) {
      try {
        if (record.value === null) {
          const response = await request(`/api/kv?key=${encodeURIComponent(record.key)}`, {
            method: 'DELETE',
          })
          if (!response.ok) continue
          await cacheDelete(record.key)
        } else {
          const response = await request('/api/kv', {
            method: 'PUT',
            body: JSON.stringify({ key: record.key, value: record.value }),
          })
          if (!response.ok) continue
          const data = (await response.json()) as { updatedAt: number }
          await cacheSet({ key: record.key, value: record.value, updatedAt: data.updatedAt })
        }
        done += 1
      } catch (err) {
        if (err instanceof AuthError) break
      }
    }
    return done
  }

  async pendingCount() {
    const all = await cacheAll()
    return all.filter((record) => record.pending).length
  }
}

/* ------------------------------------------------------------------ */

let current: KVClient = new LocalClient()

/** 按当前设置惰性校正客户端，避免设置变更后仍用旧模式发请求（F7） */
export function getClient(): KVClient {
  const mode = getSetting('server.provider')
  if (current.mode !== mode) {
    current = mode === 'cloud' ? new CloudClient() : new LocalClient()
  }
  return current
}

/** 根据当前设置重建客户端；返回新的模式 */
export function refreshClient(): ProviderMode {
  const mode = getSetting('server.provider')
  const next = mode === 'cloud' ? new CloudClient() : new LocalClient()
  if (next.mode !== current.mode) current = next
  return current.mode
}

/** 多标签页同步通道 */
export const syncChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('classworks-lite:data') : null

export function broadcastChange(key: string) {
  syncChannel?.postMessage({ type: 'change', key, at: Date.now() })
}

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

import { clearAccessToken, editTokenHeaders, getAccessCredential } from './access'
import { cacheAll, cacheDelete, cacheGet, cacheSet } from './cache'
import { getSetting } from './settings'
import type { KVEntry, ProviderMode } from './types'

export class AuthError extends Error {
  constructor(message = '访问令牌无效') {
    super(message)
    this.name = 'AuthError'
  }
}

export class EditAuthError extends Error {
  constructor(message = '需要有效的编辑令牌才能修改作业') {
    super(message)
    this.name = 'EditAuthError'
  }
}

export class NetworkError extends Error {
  constructor(message = '网络不可用') {
    super(message)
    this.name = 'NetworkError'
  }
}

/** 服务端明确拒绝了请求（如 413/409），不应作为离线改动反复重试 */
export class SaveError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'SaveError'
    this.status = status
  }
}

/** 云端数据已被其他设备修改 */
export class ConflictError extends Error {
  readonly updatedAt?: number

  constructor(message = '数据已被其他设备修改，请刷新后重试', updatedAt?: number) {
    super(message)
    this.name = 'ConflictError'
    this.updatedAt = updatedAt
  }
}

export interface SetOptions {
  /** number 表示期望的云端版本；null 表示期望该键尚不存在 */
  baseUpdatedAt?: number | null
}

export interface KVClient {
  readonly mode: ProviderMode
  get<T>(key: string): Promise<KVEntry<T> | null>
  set<T>(
    key: string,
    value: T,
    options?: SetOptions,
  ): Promise<{ entry: KVEntry<T>; queued: boolean }>
  remove(key: string): Promise<{ queued: boolean }>
  list(prefix?: string): Promise<{
    keys: { key: string; updatedAt: number }[]
    truncated: boolean
    stale?: boolean
  }>
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
    await cacheSet({ key, value, updatedAt: entry.updatedAt, synced: false })
    return { entry, queued: false }
  }

  async remove(key: string) {
    await cacheDelete(key)
    return { queued: false }
  }

  async list(prefix = '') {
    const all = await cacheAll()
    return {
      keys: all
        .filter((record) => record.key.startsWith(prefix))
        .map((record) => ({ key: record.key, updatedAt: record.updatedAt })),
      truncated: false,
      stale: false,
    }
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
  const token = getAccessCredential()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 写入被服务端拒绝后不再重复发请求，等待编辑令牌更新 */
let editDenied = false

if (typeof window !== 'undefined') {
  window.addEventListener('classworks-lite:edit-token-changed', () => {
    editDenied = false
  })
  window.addEventListener('classworks-lite:edit-authorized', () => {
    editDenied = false
  })
}

function ensureWriteAllowed() {
  if (editDenied) throw new EditAuthError()
}

function notifySyncError(key: string, message: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('classworks-lite:sync-error', { detail: { key, message } }),
  )
}

async function readError(response: Response): Promise<{
  error?: string
  message?: string
  updatedAt?: number
}> {
  try {
    return (await response.json()) as {
      error?: string
      message?: string
      updatedAt?: number
    }
  } catch {
    return {}
  }
}

async function request(
  path: string,
  init: RequestInit = {},
  withEditToken = false,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const response = await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...authHeaders(),
        ...(withEditToken ? editTokenHeaders() : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    if (response.status === 401) {
      clearAccessToken()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('classworks-lite:access-denied'))
      }
      throw new AuthError()
    }
    if (response.status === 403) {
      const error = await readError(response)
      if (error.error === 'edit_token_required') {
        editDenied = true
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('classworks-lite:edit-denied'))
        }
        throw new EditAuthError(error.message)
      }
      throw new AuthError(error.message ?? '没有权限执行此操作')
    }
    return response
  } catch (err) {
    if (err instanceof AuthError || err instanceof EditAuthError) throw err
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
        // 云端已删除：只清理明确来自云端的缓存；本地模式/旧版本地数据不能被云端 404 清掉
        if (cached?.synced === true) await cacheDelete(key)
        return null
      }
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      const data = (await response.json()) as { value: T; updatedAt: number }
      try {
        await cacheSet({
          key,
          value: data.value,
          updatedAt: data.updatedAt,
          synced: true,
        })
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
      // 没有缓存时不能把网络/服务端错误伪装成“数据不存在”，否则上层会生成空板并覆盖云端
      if (err instanceof NetworkError) throw err
      throw new NetworkError(err instanceof Error ? err.message : '读取云端数据失败')
    }
  }

  async set<T>(key: string, value: T, options: SetOptions = {}) {
    ensureWriteAllowed()
    const localUpdatedAt = Date.now()
    const cached = await cacheGet(key)
    // 显式传入的基线优先（冲突重试/条件写）；否则沿用在途离线副本的原始基线
    const hasExplicitBase = 'baseUpdatedAt' in options
    const baseUpdatedAt = hasExplicitBase
      ? options.baseUpdatedAt ?? null
      : cached?.pending && 'baseUpdatedAt' in cached
        ? (cached.baseUpdatedAt ?? null)
        : null
    const hasBase = hasExplicitBase || Boolean(cached?.pending)
    try {
      const payload: { key: string; value: T; baseUpdatedAt?: number | null } = { key, value }
      if (hasBase) payload.baseUpdatedAt = baseUpdatedAt
      const response = await request(
        '/api/kv',
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
        true,
      )
      if (response.status === 409) {
        const error = await readError(response)
        throw new ConflictError(
          error.message ?? '数据已被其他设备修改，请刷新后重试',
          error.updatedAt,
        )
      }
      if (!response.ok) {
        const error = await readError(response)
        if (response.status >= 400 && response.status < 500) {
          throw new SaveError(error.message ?? `服务端拒绝写入（${response.status}）`, response.status)
        }
        throw new NetworkError(`服务端返回 ${response.status}`)
      }
      editDenied = false
      const data = (await response.json()) as { updatedAt: number }
      const entry: KVEntry<T> = { value, updatedAt: data.updatedAt }
      try {
        await cacheSet({
          key,
          value,
          updatedAt: data.updatedAt,
          synced: true,
        })
      } catch (err) {
        console.warn('[kv] 云端写入成功但本地缓存写入失败', err)
      }
      return { entry, queued: false }
    } catch (err) {
      if (
        err instanceof AuthError ||
        err instanceof EditAuthError ||
        err instanceof ConflictError ||
        err instanceof SaveError
      ) {
        throw err
      }
      // 离线降级：写入本地并标记待同步（写不进去会抛错，避免谎报成功）
      await cacheSet({
        key,
        value,
        updatedAt: localUpdatedAt,
        pending: true,
        synced: false,
        ...(hasBase ? { baseUpdatedAt } : {}),
      })
      return { entry: { value, updatedAt: localUpdatedAt, pending: true }, queued: true }
    }
  }

  async remove(key: string) {
    ensureWriteAllowed()
    try {
      const response = await request(
        `/api/kv?key=${encodeURIComponent(key)}`,
        { method: 'DELETE' },
        true,
      )
      if (!response.ok) {
        const error = await readError(response)
        if (response.status >= 400 && response.status < 500) {
          throw new SaveError(error.message ?? `服务端拒绝删除（${response.status}）`, response.status)
        }
        throw new NetworkError(`服务端返回 ${response.status}`)
      }
      editDenied = false
      await cacheDelete(key)
      return { queued: false }
    } catch (err) {
      if (err instanceof AuthError || err instanceof EditAuthError || err instanceof SaveError) {
        throw err
      }
      await cacheSet({
        key,
        value: null,
        updatedAt: Date.now(),
        pending: true,
        synced: false,
      })
      return { queued: true }
    }
  }

  async list(prefix = '') {
    try {
      const response = await request(`/api/kv?prefix=${encodeURIComponent(prefix)}`)
      if (!response.ok) throw new NetworkError(`服务端返回 ${response.status}`)
      const data = (await response.json()) as {
        keys: { key: string; updatedAt: number }[]
        truncated?: boolean
      }
      return { keys: data.keys, truncated: Boolean(data.truncated) }
    } catch (err) {
      if (err instanceof AuthError) throw err
      // 离线时返回本地缓存并标记 stale；调用方决定是否继续全量操作
      const all = await cacheAll()
      return {
        keys: all
          .filter((record) => record.key.startsWith(prefix))
          .map((record) => ({ key: record.key, updatedAt: record.updatedAt })),
        truncated: false,
        stale: true,
      }
    }
  }

  async flush(): Promise<number> {
    if (editDenied) return 0
    const all = await cacheAll()
    const pending = all.filter((record) => record.pending)
    let done = 0
    for (const record of pending) {
      try {
        if (record.value === null) {
          const response = await request(
            `/api/kv?key=${encodeURIComponent(record.key)}`,
            { method: 'DELETE' },
            true,
          )
          if (!response.ok) {
            const error = await readError(response)
            notifySyncError(record.key, error.message ?? `删除失败（${response.status}）`)
            continue
          }
          await cacheDelete(record.key)
        } else {
          let baseUpdatedAt = 'baseUpdatedAt' in record ? record.baseUpdatedAt ?? null : null
          let rebased = false
          let response: Response | null = null
          for (let attempt = 0; ; attempt += 1) {
            const payload: {
              key: string
              value: unknown
              baseUpdatedAt?: number | null
            } = { key: record.key, value: record.value }
            if ('baseUpdatedAt' in record || attempt > 0) payload.baseUpdatedAt = baseUpdatedAt
            response = await request(
              '/api/kv',
              {
                method: 'PUT',
                body: JSON.stringify(payload),
              },
              true,
            )
            if (response.status === 409 && attempt === 0) {
              const error = await readError(response)
              if (typeof error.updatedAt === 'number') {
                baseUpdatedAt = error.updatedAt
                rebased = true
                notifySyncError(
                  record.key,
                  '检测到云端更新，正在用本地离线改动覆盖云端版本',
                )
                continue
              }
              if (baseUpdatedAt !== null) {
                // 服务端对“期望存在但已被删除”的键返回不带 updatedAt 的 409：按新建重试
                baseUpdatedAt = null
                rebased = true
                notifySyncError(record.key, '云端记录已删除，正在用本地内容重新创建')
                continue
              }
            }
            break
          }
          if (!response || !response.ok) {
            if (rebased) {
              // 记录新基线，避免下一次补传仍用旧版本反复 409
              await cacheSet({
                ...record,
                baseUpdatedAt,
                pending: true,
                synced: false,
              })
            }
            const error = response ? await readError(response) : {}
            notifySyncError(record.key, error.message ?? '补传失败，已保留本地副本')
            continue
          }
          const data = (await response.json()) as { updatedAt: number }
          await cacheSet({
            key: record.key,
            value: record.value,
            updatedAt: data.updatedAt,
            synced: true,
          })
        }
        done += 1
      } catch (err) {
        if (err instanceof AuthError || err instanceof EditAuthError) break
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

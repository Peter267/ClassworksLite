/**
 * 数据客户端。
 *
 * 站点只有云端一份作业数据，读写都发往同源的 /api/kv：
 *  - 读取成功时把结果写入本机缓存，仅为加速首屏与断网时只读展示；
 *  - 写入失败直接报错，不再把改动暂存本机排队补传。
 *
 * 服务端契约（见 server/kv-core.ts）：
 *   GET    /api/kv?key=K        -> { key, value, updatedAt } | 404
 *   GET    /api/kv?prefix=P     -> { keys: [{ key, updatedAt }] }
 *   PUT    /api/kv  { key, value, baseUpdatedAt? } -> { key, updatedAt } | 409
 *   DELETE /api/kv?key=K        -> { ok: true }
 *   鉴权：Authorization: Bearer <访问令牌>，令牌角色决定能否写入
 */

import { getAccessToken, markUnauthenticated } from './access'
import { cacheAll, cacheDelete, cacheGet, cacheSet } from './cache'
import type { KVEntry } from './types'

export class AuthError extends Error {
  constructor(message = '访问令牌无效') {
    super(message)
    this.name = 'AuthError'
  }
}

/** 只读令牌发起了写入 */
export class ReadOnlyError extends Error {
  constructor(message = '当前为只读访问，无法修改作业') {
    super(message)
    this.name = 'ReadOnlyError'
  }
}

export class NetworkError extends Error {
  constructor(message = '网络不可用') {
    super(message)
    this.name = 'NetworkError'
  }
}

/** 服务端明确拒绝了请求（如 413/409），不应反复重试 */
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
  get<T>(key: string): Promise<KVEntry<T> | null>
  set<T>(key: string, value: T, options?: SetOptions): Promise<{ entry: KVEntry<T> }>
  remove(key: string): Promise<void>
  list(prefix?: string): Promise<{
    keys: { key: string; updatedAt: number }[]
    truncated: boolean
    stale?: boolean
  }>
}

const TIMEOUT = 9000

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

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const token = getAccessToken()
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    if (response.status === 401) {
      markUnauthenticated()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('classworks-lite:access-denied'))
      }
      throw new AuthError()
    }
    if (response.status === 403) {
      const error = await readError(response)
      // read_only 为当前协议；edit_token_required 是旧服务端的拒绝码，一并按只读处理
      if (error.error === 'read_only' || error.error === 'edit_token_required') {
        throw new ReadOnlyError(error.message)
      }
      throw new AuthError(error.message ?? '没有权限执行此操作')
    }
    return response
  } catch (err) {
    if (err instanceof AuthError || err instanceof ReadOnlyError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new NetworkError('请求超时')
    }
    throw new NetworkError(err instanceof Error ? err.message : '网络不可用')
  } finally {
    clearTimeout(timer)
  }
}

export class CloudClient implements KVClient {
  async get<T>(key: string): Promise<KVEntry<T> | null> {
    const cached = await cacheGet(key)
    try {
      const response = await request(`/api/kv?key=${encodeURIComponent(key)}`)
      if (response.status === 404) {
        const error = await readError(response)
        // 只有数据接口明确回 not_found 才算「云端没有这条数据」；
        // 反代/静态托管的 404 页面按网络错误处理，避免误删本机缓存
        if (error.error !== 'not_found') {
          throw new NetworkError('服务端未返回数据接口')
        }
        if (cached) await cacheDelete(key)
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
        console.warn('[kv] 云端读取成功但本机缓存写入失败', err)
      }
      return { value: data.value, updatedAt: data.updatedAt }
    } catch (err) {
      if (err instanceof AuthError) throw err
      // 断网时允许读取本机缓存，界面会明确标注这是离线内容
      if (cached) {
        return {
          value: cached.value as T,
          updatedAt: cached.updatedAt,
          stale: true,
        }
      }
      // 没有缓存时不能把网络错误伪装成“数据不存在”，否则上层会生成空板并覆盖云端
      if (err instanceof NetworkError) throw err
      throw new NetworkError(err instanceof Error ? err.message : '读取云端数据失败')
    }
  }

  async set<T>(key: string, value: T, options: SetOptions = {}): Promise<{ entry: KVEntry<T> }> {
    const payload: { key: string; value: T; baseUpdatedAt?: number | null } = { key, value }
    if ('baseUpdatedAt' in options) payload.baseUpdatedAt = options.baseUpdatedAt ?? null

    const response = await request('/api/kv', {
      method: 'PUT',
      body: JSON.stringify(payload),
    })
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
    const data = (await response.json()) as { updatedAt: number }
    const entry: KVEntry<T> = { value, updatedAt: data.updatedAt }
    try {
      await cacheSet({ key, value, updatedAt: data.updatedAt, synced: true })
    } catch (err) {
      console.warn('[kv] 云端写入成功但本机缓存写入失败', err)
    }
    return { entry }
  }

  async remove(key: string): Promise<void> {
    const response = await request(`/api/kv?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const error = await readError(response)
      if (response.status >= 400 && response.status < 500) {
        throw new SaveError(error.message ?? `服务端拒绝删除（${response.status}）`, response.status)
      }
      throw new NetworkError(`服务端返回 ${response.status}`)
    }
    await cacheDelete(key)
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
      // 离线时返回本机缓存并标记 stale；调用方据此避免做全量改写
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
}

let current: KVClient = new CloudClient()

/** 数据客户端固定为云端；保留函数是为了调用方语义清晰 */
export function getClient(): KVClient {
  return current
}

/** 多标签页同步通道 */
export const syncChannel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('classworks-lite:data') : null

export function broadcastChange(key: string) {
  syncChannel?.postMessage({ type: 'change', key, at: Date.now() })
}

/**
 * 管理后台客户端。
 *
 * 与服务端 server/admin-core.ts 对应：登录换取 HMAC 令牌，
 * 令牌只存 sessionStorage（关闭标签页即退出），不进入长期存储。
 * 管理接口与站点同源。
 */

const TOKEN_KEY = 'classworks-lite:admin-token'
const TIMEOUT = 15_000

export class AdminError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AdminError'
    this.status = status
    this.code = code
  }
}

export interface AdminSession {
  authenticated: boolean
  expiresAt: number
  logLimit: number
}

export interface AdminKeyInfo {
  key: string
  updatedAt: number
  size: number
  group: string
}

export interface AdminGroupStat {
  id: string
  label: string
  keys: number
  bytes: number
}

export interface AdminStats {
  totalKeys: number
  totalBytes: number
  updatedLast24h: number
  lastUpdated: number
  groups: AdminGroupStat[]
  truncated: boolean
  logLimit: number
}

export interface AdminRecord {
  key: string
  value: unknown
  updatedAt: number
  size: number
  legacy: boolean
  group: string
}

export interface AdminLogEntry {
  id: string
  at: number
  actor: 'admin' | 'site'
  action: string
  key?: string
  ip?: string
  ua?: string
  size?: number
  note?: string
}

export interface AdminBackup {
  exportedAt: number
  count: number
  bytes: number
  data: Record<string, { value: unknown; updatedAt: number }>
}

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setAdminToken(token: string) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* 隐私模式下不可用，令牌只保留在内存中 */
  }
}

export function clearAdminToken() {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

async function call<T>(payload: Record<string, unknown>, token?: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const response = await fetch('/api/admin', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    })

    let data: unknown = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok) {
      const error = (data ?? {}) as { error?: string; message?: string }
      throw new AdminError(
        response.status,
        error.error ?? 'request_failed',
        error.message ?? `服务端返回 ${response.status}`,
      )
    }
    return data as T
  } catch (err) {
    if (err instanceof AdminError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AdminError(0, 'timeout', '请求超时，请检查后端服务')
    }
    throw new AdminError(0, 'network_error', '无法连接管理接口，请检查网络与后端部署')
  } finally {
    clearTimeout(timer)
  }
}

export const adminApi = {
  login: (password: string) =>
    call<{ token: string; expiresAt: number }>({ action: 'login', password }),
  session: (token: string) => call<AdminSession>({ action: 'session' }, token),
  stats: (token: string) => call<AdminStats>({ action: 'stats' }, token),
  keys: (token: string) =>
    call<{ keys: AdminKeyInfo[]; truncated: boolean }>({ action: 'keys' }, token),
  overview: (token: string) =>
    call<{ stats: AdminStats; keys: AdminKeyInfo[]; truncated: boolean }>(
      { action: 'overview' },
      token,
    ),
  get: (token: string, key: string) => call<AdminRecord>({ action: 'get', key }, token),
  save: (token: string, key: string, value: unknown, baseUpdatedAt?: number) =>
    call<{ key: string; updatedAt: number; size: number }>(
      {
        action: 'put',
        key,
        value,
        ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
      },
      token,
    ),
  remove: (token: string, key: string, baseUpdatedAt?: number) =>
    call<{ ok: boolean; key: string }>(
      {
        action: 'delete',
        key,
        ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
      },
      token,
    ),
  logs: (token: string) =>
    call<{ logs: AdminLogEntry[]; limit: number }>({ action: 'logs' }, token),
  backup: (token: string) => call<AdminBackup>({ action: 'backup' }, token),
  clearLogs: (token: string) => call<{ ok: boolean }>({ action: 'clear_logs' }, token),
}

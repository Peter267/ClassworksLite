/**
 * 站点访问控制客户端。
 *
 * 访问密码登录后拿到 HMAC 令牌，保存在 localStorage（服务端有效期 7 天），
 * 读取 /api/kv 时通过 Authorization 携带；编辑令牌来自设置 server.editToken，
 * 写入 / 删除时通过 X-Edit-Token 携带。
 */

import { getSetting } from './settings'
import { toast } from './toast'

const TOKEN_KEY = 'classworks-lite:access-token'
const EXPIRES_KEY = 'classworks-lite:access-expires'
const TIMEOUT = 12_000
export const ACCESS_STATUS_EVENT = 'classworks-lite:access-status'

export class AccessError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AccessError'
    this.status = status
    this.code = code
  }
}

export interface AccessStatus {
  passwordRequired: boolean
  editRequired: boolean
  authenticated: boolean
  editAuthenticated: boolean
  /** 后端没有 /api/auth（旧版部署） */
  unsupported: boolean
  checkedAt: number
}

let status: AccessStatus | null = null
const listeners = new Set<() => void>()
let lastEditNotice = 0
let editTokenTimer: ReturnType<typeof setTimeout> | null = null
/** 隐私模式下 localStorage 不可用时，令牌只保留在内存中 */
let memoryToken: { token: string; expiresAt: number } | null = null

function emit() {
  listeners.forEach((fn) => fn())
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACCESS_STATUS_EVENT))
}

export function subscribeAccess(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function getAccessStatus(): AccessStatus | null {
  return status
}

function apiBase(): string {
  const configured = getSetting('server.domain').trim()
  if (!configured) return ''
  return configured.replace(/\/+$/, '')
}

/* ------------------------------------------------------------------ */
/* 令牌存储                                                            */
/* ------------------------------------------------------------------ */

export function getAccessToken(): string | null {
  const usable = (expiresAt: number) =>
    Number.isFinite(expiresAt) && expiresAt > Date.now() + 30_000

  if (memoryToken) {
    if (usable(memoryToken.expiresAt)) return memoryToken.token
    memoryToken = null
  }

  try {
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) return null
    const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) ?? 0)
    if (!usable(expiresAt)) {
      clearAccessToken()
      return null
    }
    memoryToken = { token, expiresAt }
    return token
  } catch {
    return memoryToken?.token ?? null
  }
}

export function setAccessToken(token: string, expiresAt: number) {
  memoryToken = { token, expiresAt }
  try {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(EXPIRES_KEY, String(expiresAt))
  } catch {
    /* 隐私模式下 localStorage 不可用，令牌保存在内存中直到刷新页面 */
  }
}

export function clearAccessToken() {
  memoryToken = null
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(EXPIRES_KEY)
  } catch {
    /* ignore */
  }
}

/** 读取凭证：优先访问令牌，其次旧版静态 SITE_TOKEN */
export function getAccessCredential(): string | null {
  return getAccessToken() ?? (getSetting('server.siteKey').trim() || null)
}

export function editTokenHeaders(): Record<string, string> {
  const token = getSetting('server.editToken').trim()
  return token ? { 'X-Edit-Token': token } : {}
}

/* ------------------------------------------------------------------ */
/* 接口调用                                                            */
/* ------------------------------------------------------------------ */

function baseHeaders(): Record<string, string> {
  const token = getAccessCredential()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    return await fetch(`${apiBase()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...baseHeaders(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new AccessError(0, 'timeout', '请求超时，请检查网络与后端服务')
    }
    throw new AccessError(0, 'network_error', '无法连接服务器，请检查网络与后端部署')
  } finally {
    clearTimeout(timer)
  }
}

async function readError(response: Response): Promise<{ error?: string; message?: string }> {
  try {
    return (await response.json()) as { error?: string; message?: string }
  } catch {
    return {}
  }
}

/** 状态请求必须同时携带访问令牌和编辑令牌，否则 editAuthenticated 永远为 false */
function notifyEditAuthorized(next: AccessStatus) {
  status = next
  emit()
  if (
    typeof window !== 'undefined' &&
    next.authenticated &&
    (!next.editRequired || next.editAuthenticated)
  ) {
    // kv.ts 监听该事件清除“写入被拒”的粘滞标记
    window.dispatchEvent(new CustomEvent('classworks-lite:edit-authorized'))
  }
}

/** 拉取服务端访问状态；网络失败返回 null 并保留上一次状态 */
export async function refreshAccessStatus(): Promise<AccessStatus | null> {
  try {
    const response = await request('/api/auth', {
      method: 'GET',
      headers: editTokenHeaders(),
    })
    if (response.status === 404) {
      notifyEditAuthorized({
        passwordRequired: false,
        editRequired: false,
        authenticated: true,
        editAuthenticated: true,
        unsupported: true,
        checkedAt: Date.now(),
      })
      return status
    }
    if (!response.ok) return null
    const data = (await response.json()) as Partial<AccessStatus>
    notifyEditAuthorized({
      passwordRequired: Boolean(data.passwordRequired),
      editRequired: Boolean(data.editRequired),
      authenticated: Boolean(data.authenticated),
      editAuthenticated: Boolean(data.editAuthenticated),
      unsupported: false,
      checkedAt: Date.now(),
    })
    return status
  } catch {
    return null
  }
}

export async function loginWithPassword(password: string): Promise<AccessStatus> {
  const response = await request('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ action: 'login', password }),
  })

  if (!response.ok) {
    const error = await readError(response)
    throw new AccessError(
      response.status,
      error.error ?? 'login_failed',
      error.message ?? '登录失败，请稍后重试',
    )
  }

  const data = (await response.json()) as { token?: unknown; expiresAt?: unknown }
  if (typeof data.token !== 'string' || typeof data.expiresAt !== 'number') {
    throw new AccessError(500, 'bad_response', '服务端返回的访问令牌无效')
  }

  setAccessToken(data.token, data.expiresAt)
  const next = await refreshAccessStatus()
  if (next) return next

  const fallback: AccessStatus = {
    passwordRequired: true,
    editRequired: Boolean(getSetting('server.editToken').trim()),
    authenticated: true,
    editAuthenticated: false,
    unsupported: false,
    checkedAt: Date.now(),
  }
  status = fallback
  emit()
  return fallback
}

/** 服务端要求编辑令牌但当前令牌未通过校验时为只读模式；本地模式不受云端状态影响 */
export function isEditLocked(): boolean {
  if (getSetting<string>('server.provider') !== 'cloud') return false
  return Boolean(status?.editRequired && !status.editAuthenticated)
}

/* ------------------------------------------------------------------ */
/* 全局事件                                                            */
/* ------------------------------------------------------------------ */

if (typeof window !== 'undefined') {
  // 编辑令牌 / 服务器地址 / 站点令牌 / 存储模式变更后重新校验；状态更新事件供 store 恢复自动保存
  window.addEventListener('classworks-lite:settings', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key
    if (!key) return
    if (key === 'server.editToken') {
      window.dispatchEvent(new CustomEvent('classworks-lite:edit-token-changed'))
    } else if (
      key !== 'server.domain' &&
      key !== 'server.siteKey' &&
      key !== 'server.provider'
    ) {
      return
    }
    if (editTokenTimer) clearTimeout(editTokenTimer)
    editTokenTimer = setTimeout(() => {
      editTokenTimer = null
      if (getSetting<string>('server.provider') === 'cloud') {
        void refreshAccessStatus()
      } else {
        // 本模式无需联网校验，清掉云端遗留的只读状态
        status = null
        emit()
      }
    }, 600)
  })

  window.addEventListener('classworks-lite:edit-denied', () => {
    const now = Date.now()
    if (now - lastEditNotice > 5000) {
      lastEditNotice = now
      toast.warning('需要编辑令牌', '请在 设置 → 服务器 → 访问权限 中填写后重试')
    }
    void refreshAccessStatus()
  })

  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY || event.key === EXPIRES_KEY) {
      // 另一个标签页更新/清除了令牌，丢弃本标签页的内存副本后重新读取
      memoryToken = null
      emit()
    }
  })
}

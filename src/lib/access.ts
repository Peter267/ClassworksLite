/**
 * 站点访问控制客户端。
 *
 * 站点只有云端一份数据，读取前先向 /api/auth 确认访问状态：
 *  - 未启用访问密码：直接进入，可读可写；
 *  - 已启用：弹出密码门，只读密码与可写密码共用同一个输入框，
 *    登录后由服务端签发的令牌携带角色，客户端据此决定能否编辑。
 *
 * 令牌保存在 localStorage（有效期 7 天），读写 /api/kv 时通过 Authorization 携带。
 */

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
  authenticated: boolean
  /** 使用可写密码登录时为 true；只读密码为 false */
  canEdit: boolean
  checkedAt: number
}

let status: AccessStatus | null = null
const listeners = new Set<() => void>()
/** 隐私模式下 localStorage 不可用时，令牌只保留在内存中 */
let memoryToken: { token: string; expiresAt: number } | null = null
let readOnlyNoticeAt = 0

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

function setStatus(next: AccessStatus) {
  status = next
  emit()
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

/** 服务端拒绝令牌：立即把会话标记为未认证，避免后续自动保存继续打 401 */
export function markUnauthenticated() {
  clearAccessToken()
  setStatus({
    passwordRequired: true,
    authenticated: false,
    canEdit: false,
    checkedAt: Date.now(),
  })
}

/** 当前是否只有查看权限；未认证（令牌失效）按只读处理，避免误触发写入 */
export function isReadOnly(): boolean {
  if (!status) return false
  return !status.canEdit
}

/** 只读用户尝试写入时给出一次提示，避免连续操作刷屏 */
export function notifyReadOnly(): void {
  const now = Date.now()
  if (now - readOnlyNoticeAt < 3000) return
  readOnlyNoticeAt = now
  toast.warning('当前为只读访问', '需要修改作业时，请在 设置 → 服务器 → 访问权限 中退出后重新输入可写密码')
}

/* ------------------------------------------------------------------ */
/* 接口调用                                                            */
/* ------------------------------------------------------------------ */

function baseHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    return await fetch(path, {
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
      throw new AccessError(0, 'timeout', '请求超时，请检查网络')
    }
    throw new AccessError(0, 'network_error', '无法连接服务器，请检查网络')
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

/**
 * 拉取服务端访问状态。
 * 返回 null 表示站点未部署接口或网络不可用——调用方应展示「无法连接」而不是放行。
 */
export async function refreshAccessStatus(): Promise<AccessStatus | null> {
  try {
    const response = await request('/api/auth', { method: 'GET' })
    if (!response.ok) return null
    const data = (await response.json()) as {
      passwordRequired?: boolean
      authenticated?: boolean
      canEdit?: boolean
    }
    const next: AccessStatus = {
      passwordRequired: Boolean(data.passwordRequired),
      authenticated: Boolean(data.authenticated),
      canEdit: Boolean(data.canEdit),
      checkedAt: Date.now(),
    }
    setStatus(next)
    return next
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

  const data = (await response.json()) as {
    token?: unknown
    expiresAt?: unknown
    canEdit?: unknown
  }
  if (typeof data.token !== 'string' || typeof data.expiresAt !== 'number') {
    throw new AccessError(500, 'bad_response', '登录状态异常，请刷新页面重试')
  }

  setAccessToken(data.token, data.expiresAt)
  const next: AccessStatus = {
    passwordRequired: true,
    authenticated: true,
    canEdit: Boolean(data.canEdit),
    checkedAt: Date.now(),
  }
  setStatus(next)
  return next
}

/* ------------------------------------------------------------------ */
/* 全局事件                                                            */
/* ------------------------------------------------------------------ */

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === TOKEN_KEY || event.key === EXPIRES_KEY) {
      // 另一个标签页更新/清除了令牌，丢弃本标签页的内存副本后重新确认角色
      memoryToken = null
      emit()
      void refreshAccessStatus()
    }
  })
}

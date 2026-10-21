/**
 * 站点访问控制接口：/api/auth
 *
 * 两级权限：
 *   访问密码 SITE_PASSWORD → 校验通过后签发 HMAC 令牌（默认 7 天），用于读取作业；
 *   编辑令牌 EDIT_TOKEN    → 写入 / 删除时通过 X-Edit-Token 校验，用于修改作业。
 *
 * 未配置 SITE_PASSWORD 时保持旧行为：可继续使用静态 SITE_TOKEN，或完全开放。
 * 未配置 EDIT_TOKEN 时不限制写入。
 */
import { appendAudit, clientIp, clientUserAgent } from './audit'
import type { Backend } from './kv-core'
import { createLoginGuard } from './login-guard'
import { constantTimeEqual, createToken, verifyToken } from './token'

const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024
const GUARD_KEY = '__access-guard'
const STATUS_EDIT_LIMIT = 5
const STATUS_EDIT_LOCK_MS = 10 * 60 * 1000
const statusEditFailures = new Map<string, { n: number; first: number; until: number }>()

function statusEditLocked(ip: string): boolean {
  const entry = statusEditFailures.get(ip)
  return Boolean(entry && entry.until > Date.now())
}

function recordStatusEditFailure(ip: string) {
  const now = Date.now()
  const current = statusEditFailures.get(ip)
  const next =
    current && now - current.first < STATUS_EDIT_LOCK_MS
      ? current
      : { n: 0, first: now, until: 0 }
  next.n += 1
  if (next.n >= STATUS_EDIT_LIMIT) next.until = now + STATUS_EDIT_LOCK_MS
  statusEditFailures.set(ip, next)
  if (statusEditFailures.size > 500) {
    for (const [key, value] of statusEditFailures) {
      if (value.until <= now) statusEditFailures.delete(key)
    }
  }
}

export interface AccessOptions {
  /** 站点访问密码；为空表示不启用密码门 */
  sitePassword?: string
  /** 编辑令牌；为空表示任何能查看的人都可写入 */
  editToken?: string
  /** 旧版静态访问令牌，仍可作为访问凭证使用 */
  siteToken?: string
  /** 访问令牌签名密钥，留空时使用 SITE_PASSWORD */
  secret?: string
  corsOrigin?: string
}

const encoder = new TextEncoder()

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(origin?: string): Record<string, string> {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Edit-Token, X-Site-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(data: unknown, status = 200, origin?: string) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  })
}

/* ------------------------------------------------------------------ */
/* 凭证校验                                                            */
/* ------------------------------------------------------------------ */

function accessSecret(options: AccessOptions): string {
  const suffix = options.secret && options.secret.length > 0 ? options.secret : options.sitePassword
  return `classworks-lite-access:${suffix ?? ''}`
}

function readBearer(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return null
}

function readSiteToken(request: Request): string | null {
  return readBearer(request) ?? request.headers.get('x-site-key')?.trim() ?? null
}

export async function isViewAuthorized(
  request: Request,
  options: AccessOptions,
): Promise<boolean> {
  if (!options.sitePassword) {
    if (!options.siteToken) return true
    const token = readSiteToken(request)
    return token !== null && (await constantTimeEqual(token, options.siteToken))
  }

  const token = readBearer(request)
  if (!token) return false
  // 迁移期兼容：旧版静态令牌仍可访问
  if (options.siteToken && (await constantTimeEqual(token, options.siteToken))) return true
  return (await verifyToken(token, accessSecret(options))) !== null
}

export async function isEditAuthorized(
  request: Request,
  options: AccessOptions,
): Promise<boolean> {
  if (!options.editToken) return true
  const provided = request.headers.get('x-edit-token')?.trim() ?? ''
  if (!provided) return false
  return constantTimeEqual(provided, options.editToken)
}

/* ------------------------------------------------------------------ */
/* 状态与登录                                                          */
/* ------------------------------------------------------------------ */

async function handleStatus(
  request: Request,
  options: AccessOptions,
): Promise<Response> {
  const authenticated = await isViewAuthorized(request, options)
  let editAuthenticated = false
  if (authenticated) {
    if (!options.editToken) {
      editAuthenticated = true
    } else {
      const ip = clientIp(request)
      const provided = request.headers.get('x-edit-token')?.trim()
      if (provided && !statusEditLocked(ip)) {
        editAuthenticated = await isEditAuthorized(request, options)
        if (editAuthenticated) {
          statusEditFailures.delete(ip)
        } else {
          recordStatusEditFailure(ip)
        }
      }
    }
  }
  return json(
    {
      passwordRequired: Boolean(options.sitePassword),
      editRequired: Boolean(options.editToken),
      authenticated,
      editAuthenticated,
    },
    200,
    options.corsOrigin,
  )
}

async function handleLogin(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  options: AccessOptions,
): Promise<Response> {
  if (!options.sitePassword) {
    return json(
      { error: 'not_configured', message: '服务端未启用访问密码' },
      400,
      options.corsOrigin,
    )
  }

  const ip = clientIp(request)
  const ua = clientUserAgent(request)
  const guard = createLoginGuard(backend, GUARD_KEY)

  const lockedMinutes = await guard.locked(ip)
  if (lockedMinutes > 0) {
    return json(
      { error: 'too_many_attempts', message: `尝试次数过多，请 ${lockedMinutes} 分钟后再试` },
      429,
      options.corsOrigin,
    )
  }

  const password = typeof body.password === 'string' ? body.password : ''
  const ok = password.length > 0 && (await constantTimeEqual(password, options.sitePassword))

  if (!ok) {
    const lockedFor = await guard.fail(ip)
    await appendAudit(backend, {
      actor: 'site',
      action: 'login_failed',
      ip,
      ua,
      note: lockedFor > 0 ? '访问密码连续错误，已临时锁定' : '访问密码错误',
    })
    return json({ error: 'invalid_password', message: '访问密码错误' }, 401, options.corsOrigin)
  }

  await guard.reset(ip)

  const { token, expiresAt } = await createToken(accessSecret(options), ACCESS_TTL_MS)
  await appendAudit(backend, { actor: 'site', action: 'login', ip, ua, note: '访问密码登录' })
  return json(
    {
      token,
      expiresAt,
      passwordRequired: true,
      editRequired: Boolean(options.editToken),
    },
    200,
    options.corsOrigin,
  )
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export async function handleAccess(
  request: Request,
  backend: Backend,
  options: AccessOptions = {},
): Promise<Response> {
  // 与 /api/kv 保持一致：未配置 CORS_ORIGIN 时默认允许跨域（仅 Bearer/编辑令牌，不使用 Cookie）
  const origin = options.corsOrigin ?? '*'
  const config: AccessOptions = { ...options, corsOrigin: origin }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (request.method === 'GET') {
    return handleStatus(request, config)
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, origin)
  }

  const text = await request.text()
  if (encoder.encode(text).byteLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large', message: '请求体过大' }, 413, origin)
  }

  let body: Record<string, unknown>
  try {
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400, origin)
  }

  const action = typeof body.action === 'string' ? body.action : 'login'

  try {
    if (action === 'login') return await handleLogin(request, backend, body, config)
    if (action === 'status') return await handleStatus(request, config)
    return json({ error: 'unknown_action', message: '未知操作' }, 400, origin)
  } catch (err) {
    console.error('[auth] 处理失败', err)
    return json({ error: 'internal_error', message: '服务器处理失败' }, 500, origin)
  }
}

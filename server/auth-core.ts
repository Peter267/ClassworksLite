/**
 * 站点访问控制接口：/api/auth
 *
 * 单一密码框、两套密码：
 *   只读密码 SITE_PASSWORD → 登录后只能查看作业；
 *   可写密码 EDIT_PASSWORD → 登录后可以查看并修改作业。
 *
 * 登录成功后签发带角色的 HMAC 令牌（默认 7 天），/api/kv 依据令牌角色决定是否允许写入。
 * 两个密码都未配置时不启用访问门，视为完全开放。
 */
import { appendAudit, clientIp, clientUserAgent } from './audit'
import type { Backend } from './kv-core'
import { createLoginGuard } from './login-guard'
import { constantTimeEqual, createToken, verifyToken, type TokenRole } from './token'

const ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024
const GUARD_KEY = '__access-guard'

export interface AccessOptions {
  /** 只读密码；为空表示没有只读入口 */
  viewPassword?: string
  /** 可写密码；为空表示不能通过登录获得写权限 */
  editPassword?: string
  /** 访问令牌签名密钥，留空时由两个密码派生（改密码即全体失效） */
  secret?: string
  corsOrigin?: string
}

/** 登录后获得的站点角色，admin 令牌不参与站点访问 */
export type AccessRole = Extract<TokenRole, 'view' | 'edit'>

const encoder = new TextEncoder()

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(origin?: string): Record<string, string> {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
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
  // 两个密码与 AUTH_SECRET 一起参与派生：任一项变更都会让已签发的令牌立即失效，
  // 用长度前缀避免密码里出现分隔符时的拼接歧义
  const fingerprint = `${(options.viewPassword ?? '').length}:${options.viewPassword ?? ''}|${(options.editPassword ?? '').length}:${options.editPassword ?? ''}`
  const suffix = options.secret && options.secret.length > 0
    ? `${options.secret.length}:${options.secret}|${fingerprint}`
    : fingerprint
  return `classworks-lite-access:${suffix}`
}

function passwordRequired(options: AccessOptions): boolean {
  return Boolean(options.viewPassword || options.editPassword)
}

function readBearer(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  return null
}

/** 返回请求令牌对应的角色；未登录或令牌无效返回 null */
export async function authorizeAccess(
  request: Request,
  options: AccessOptions,
): Promise<AccessRole | null> {
  if (!passwordRequired(options)) return 'edit'
  const token = readBearer(request)
  if (!token) return null
  const payload = await verifyToken(token, accessSecret(options))
  if (!payload) return null
  if (payload.role !== 'view' && payload.role !== 'edit') return null
  return payload.role
}

/* ------------------------------------------------------------------ */
/* 状态与登录                                                          */
/* ------------------------------------------------------------------ */

async function handleStatus(
  request: Request,
  options: AccessOptions,
): Promise<Response> {
  const role = await authorizeAccess(request, options)
  return json(
    {
      passwordRequired: passwordRequired(options),
      authenticated: role !== null,
      canEdit: role === 'edit',
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
  if (!passwordRequired(options)) {
    return json(
      { error: 'not_configured', message: '本站未启用访问密码' },
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
  // 两个密码都做常量时间比较，避免通过响应时间区分命中的是哪一个
  const [matchesEdit, matchesView] = await Promise.all([
    password.length > 0 && options.editPassword
      ? constantTimeEqual(password, options.editPassword)
      : Promise.resolve(false),
    password.length > 0 && options.viewPassword
      ? constantTimeEqual(password, options.viewPassword)
      : Promise.resolve(false),
  ])
  const role: AccessRole | null = matchesEdit ? 'edit' : matchesView ? 'view' : null

  if (!role) {
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

  const { token, expiresAt } = await createToken(accessSecret(options), ACCESS_TTL_MS, role)
  await appendAudit(backend, {
    actor: 'site',
    action: 'login',
    ip,
    ua,
    note: role === 'edit' ? '可写密码登录' : '只读密码登录',
  })
  return json(
    {
      token,
      expiresAt,
      passwordRequired: true,
      canEdit: role === 'edit',
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
  // 与 /api/kv 保持一致：未配置 CORS_ORIGIN 时默认允许跨域（仅 Bearer，不使用 Cookie）
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

  const declared = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large', message: '请求体过大' }, 413, origin)
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

/**
 * 管理后台接口：与 /api/kv 共用同一个 Backend，三种运行时复用。
 *
 * 鉴权流程：
 *   POST { action: "login", password } -> HMAC-SHA256 签名令牌（有效期 12 小时）
 *   其余请求携带 Authorization: Bearer <token>
 *
 * 管理密码来自环境变量 ADMIN_PASSWORD；未配置时接口返回 503，后台保持禁用。
 */
import {
  AUDIT_LIMIT,
  appendAudit,
  clearAudit,
  clientIp,
  clientUserAgent,
  readAudit,
} from './audit'
import type { Backend, StoredRecord } from './kv-core'
import { createLoginGuard } from './login-guard'
import { constantTimeEqual, createToken, verifyToken } from './token'

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000
const MAX_BODY_BYTES = 1_500_000
const MAX_LOGIN_BODY_BYTES = 16 * 1024
const MAX_VALUE_BYTES = 1_000_000
const MAX_KEYS = 1000
const MAX_BACKUP_BYTES = 8 * 1024 * 1024
const GUARD_KEY = '__admin-guard'
const RESERVED_PREFIX = '__'

const encoder = new TextEncoder()

export interface AdminOptions {
  password?: string
  secret?: string
  corsOrigin?: string
}

interface KeyRecord {
  key: string
  value: unknown
  updatedAt: number
  size: number
  legacy: boolean
}

/* ------------------------------------------------------------------ */
/* 响应与编码                                                          */
/* ------------------------------------------------------------------ */

function corsHeaders(origin?: string): Record<string, string> {
  if (!origin) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Token',
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

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

/* ------------------------------------------------------------------ */
/* 密码与令牌                                                          */
/* ------------------------------------------------------------------ */

function tokenSecret(options: AdminOptions): string {
  const suffix = options.secret && options.secret.length > 0 ? options.secret : options.password
  return `classworks-lite-admin:${suffix ?? ''}`
}

function readToken(request: Request): string | null {
  const auth = request.headers.get('authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  const header = request.headers.get('x-admin-token')
  return header ? header.trim() : null
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function handleLogin(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  options: AdminOptions,
): Promise<Response> {
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
  const expected = options.password ?? ''
  const ok = password.length > 0 && (await constantTimeEqual(password, expected))

  if (!ok) {
    const lockedFor = await guard.fail(ip)
    await appendAudit(backend, {
      actor: 'admin',
      action: 'login_failed',
      ip,
      ua,
      note: lockedFor > 0 ? '连续失败，已临时锁定' : '密码错误',
    })
    return json({ error: 'invalid_password', message: '密码错误' }, 401, options.corsOrigin)
  }

  await guard.reset(ip)

  const { token, expiresAt } = await createToken(tokenSecret(options), TOKEN_TTL_MS, 'admin')
  await appendAudit(backend, { actor: 'admin', action: 'login', ip, ua })
  return json({ token, expiresAt }, 200, options.corsOrigin)
}

/* ------------------------------------------------------------------ */
/* 数据读取与归类                                                      */
/* ------------------------------------------------------------------ */

function isDataKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 200 &&
    !key.startsWith(RESERVED_PREFIX) &&
    !/[\u0000-\u001f\u007f]/.test(key)
  )
}

function parseRecord(raw: string): { value: unknown; updatedAt: number; legacy: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && 'v' in parsed) {
      const record = parsed as Partial<StoredRecord>
      return {
        value: record.v,
        updatedAt: typeof record.t === 'number' ? record.t : 0,
        legacy: false,
      }
    }
    return { value: parsed, updatedAt: 0, legacy: true }
  } catch {
    return { value: raw, updatedAt: 0, legacy: true }
  }
}

function groupOf(key: string): { id: string; label: string } {
  if (key.startsWith('classworks-data-')) return { id: 'boards', label: '作业数据' }
  if (key === 'classworks-list-main') return { id: 'roster', label: '花名册' }
  if (key === 'classworks-config-subject') return { id: 'subjects', label: '科目' }
  if (key === 'classworks-exams') return { id: 'exams', label: '考试' }
  if (key === 'classworks-config-homework-template') return { id: 'template', label: '作业模板' }
  if (key === 'noise-session-config') return { id: 'noise', label: '噪音时段' }
  return { id: 'other', label: '其他' }
}

async function collectRecords(
  backend: Backend,
): Promise<{ records: KeyRecord[]; truncated: boolean }> {
  const names = (await backend.scan(''))
    .filter((name) => !name.startsWith(RESERVED_PREFIX))
    .sort()
  const truncated = names.length > MAX_KEYS
  const selected = names.slice(0, MAX_KEYS)
  const records: KeyRecord[] = []

  for (let index = 0; index < selected.length; index += 25) {
    const batch = selected.slice(index, index + 25)
    const items = await Promise.all(
      batch.map(async (key) => {
        const raw = await backend.read(key)
        if (raw === null) return null
        const parsed = parseRecord(raw)
        return { key, ...parsed, size: byteLength(raw) }
      }),
    )
    for (const item of items) if (item) records.push(item)
  }

  return { records, truncated }
}

/* ------------------------------------------------------------------ */
/* 各管理动作                                                          */
/* ------------------------------------------------------------------ */

function statsFromRecords(records: KeyRecord[], truncated: boolean) {
  const groups = new Map<string, { id: string; label: string; keys: number; bytes: number }>()
  let totalBytes = 0
  let lastUpdated = 0

  for (const record of records) {
    const group = groupOf(record.key)
    const entry = groups.get(group.id) ?? { ...group, keys: 0, bytes: 0 }
    entry.keys += 1
    entry.bytes += record.size
    groups.set(group.id, entry)
    totalBytes += record.size
    if (record.updatedAt > lastUpdated) lastUpdated = record.updatedAt
  }

  const since = Date.now() - 86_400_000
  return {
    totalKeys: records.length,
    totalBytes,
    updatedLast24h: records.filter((record) => record.updatedAt >= since).length,
    lastUpdated,
    groups: [...groups.values()].sort((a, b) => b.keys - a.keys),
    truncated,
    logLimit: AUDIT_LIMIT,
  }
}

function keysFromRecords(records: KeyRecord[], truncated: boolean) {
  return {
    keys: records.map((record) => ({
      key: record.key,
      updatedAt: record.updatedAt,
      size: record.size,
      group: groupOf(record.key).id,
    })),
    truncated,
  }
}

async function handleStats(backend: Backend, origin?: string): Promise<Response> {
  const { records, truncated } = await collectRecords(backend)
  return json(statsFromRecords(records, truncated), 200, origin)
}

async function handleKeys(backend: Backend, origin?: string): Promise<Response> {
  const { records, truncated } = await collectRecords(backend)
  return json(keysFromRecords(records, truncated), 200, origin)
}

/** 概览一次扫描同时返回统计和键列表，避免打开后台时重复读取全部记录 */
async function handleOverview(backend: Backend, origin?: string): Promise<Response> {
  const { records, truncated } = await collectRecords(backend)
  return json(
    {
      stats: statsFromRecords(records, truncated),
      ...keysFromRecords(records, truncated),
    },
    200,
    origin,
  )
}

async function handleGet(
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!isDataKey(body.key)) {
    return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
  }
  const raw = await backend.read(body.key)
  if (raw === null) {
    return json({ error: 'not_found', message: '数据键不存在' }, 404, origin)
  }
  const parsed = parseRecord(raw)
  return json(
    {
      key: body.key,
      value: parsed.value ?? null,
      updatedAt: parsed.updatedAt,
      size: byteLength(raw),
      legacy: parsed.legacy,
      group: groupOf(body.key).id,
    },
    200,
    origin,
  )
}

async function handlePut(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!isDataKey(body.key)) {
    return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
  }
  if (!('value' in body)) {
    return json({ error: 'bad_request', message: '缺少 value' }, 400, origin)
  }

  const key = body.key
  const raw = await backend.read(key)
  const base = typeof body.baseUpdatedAt === 'number' ? body.baseUpdatedAt : null

  if (base === null) {
    if (raw !== null) {
      return json(
        { error: 'conflict', message: '该数据键已存在，请刷新列表后重试' },
        409,
        origin,
      )
    }
  } else if (raw === null) {
    return json(
      { error: 'conflict', message: '数据已被删除，请刷新列表后重试' },
      409,
      origin,
    )
  } else {
    const current = parseRecord(raw)
    if (current.updatedAt !== base) {
      return json(
        {
          error: 'conflict',
          message: '数据已被其他操作修改，请刷新后重试',
          updatedAt: current.updatedAt,
        },
        409,
        origin,
      )
    }
  }

  const record: StoredRecord = { v: body.value, t: Date.now() }
  const serialized = JSON.stringify(record)
  const size = byteLength(serialized)
  if (size > MAX_VALUE_BYTES) {
    return json({ error: 'payload_too_large', message: '数据超过 1MB' }, 413, origin)
  }

  await backend.write(key, serialized)
  await appendAudit(backend, {
    actor: 'admin',
    action: 'write',
    key,
    size,
    ip: clientIp(request),
    ua: clientUserAgent(request),
  })
  return json({ key, updatedAt: record.t, size }, 200, origin)
}

async function handleDelete(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!isDataKey(body.key)) {
    return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
  }

  const key = body.key
  const raw = await backend.read(key)
  if (raw === null) {
    return json({ ok: true, key, missing: true }, 200, origin)
  }

  if (typeof body.baseUpdatedAt === 'number') {
    const current = parseRecord(raw)
    if (current.updatedAt !== body.baseUpdatedAt) {
      return json(
        { error: 'conflict', message: '数据已被其他操作修改，请刷新后重试' },
        409,
        origin,
      )
    }
  }

  await backend.remove(key)
  await appendAudit(backend, {
    actor: 'admin',
    action: 'delete',
    key,
    ip: clientIp(request),
    ua: clientUserAgent(request),
  })
  return json({ ok: true, key }, 200, origin)
}

async function handleBackup(backend: Backend, origin?: string): Promise<Response> {
  const { records, truncated } = await collectRecords(backend)
  if (truncated) {
    return json(
      { error: 'too_many_keys', message: `数据键超过 ${MAX_KEYS} 条，请分批导出` },
      413,
      origin,
    )
  }

  let bytes = 0
  for (const record of records) bytes += record.size
  if (bytes > MAX_BACKUP_BYTES) {
    return json(
      { error: 'backup_too_large', message: '数据总大小超过 8MB，请分批导出' },
      413,
      origin,
    )
  }

  const data: Record<string, { value: unknown; updatedAt: number }> = {}
  for (const record of records) {
    data[record.key] = { value: record.value, updatedAt: record.updatedAt }
  }
  return json({ exportedAt: Date.now(), count: records.length, bytes, data }, 200, origin)
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export async function handleAdmin(
  request: Request,
  backend: Backend,
  options: AdminOptions = {},
): Promise<Response> {
  // 与 /api/kv 一致：默认允许跨域，但管理操作仍必须携带有效 Bearer 令牌
  const origin = options.corsOrigin ?? '*'
  const config: AdminOptions = { ...options, corsOrigin: origin }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  }

  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405, origin)
  }

  if (!options.password) {
    return json(
      {
        error: 'admin_not_configured',
        message: '管理后台未启用，请联系管理员',
      },
      503,
      origin,
    )
  }

  const text = await request.text()
  if (byteLength(text) > MAX_BODY_BYTES) {
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

  const action = typeof body.action === 'string' ? body.action : ''
  if (action === 'login') {
    if (byteLength(text) > MAX_LOGIN_BODY_BYTES) {
      return json({ error: 'payload_too_large', message: '请求体过大' }, 413, origin)
    }
    return handleLogin(request, backend, body, config)
  }

  if (!action) {
    return json({ error: 'bad_request', message: '缺少 action' }, 400, origin)
  }

  const token = readToken(request)
  const payload = token ? await verifyToken(token, tokenSecret(options)) : null
  if (!payload || payload.role !== 'admin') {
    return json(
      { error: 'unauthorized', message: '管理会话已过期，请重新登录' },
      401,
      origin,
    )
  }
  const expiresAt = payload.expiresAt

  try {
    switch (action) {
      case 'session':
        return json({ authenticated: true, expiresAt, logLimit: AUDIT_LIMIT }, 200, origin)
      case 'stats':
        return await handleStats(backend, origin)
      case 'keys':
        return await handleKeys(backend, origin)
      case 'overview':
        return await handleOverview(backend, origin)
      case 'get':
        return await handleGet(backend, body, origin)
      case 'put':
        return await handlePut(request, backend, body, origin)
      case 'delete':
        return await handleDelete(request, backend, body, origin)
      case 'logs': {
        const logs = await readAudit(backend)
        return json({ logs, limit: AUDIT_LIMIT }, 200, origin)
      }
      case 'backup':
        return await handleBackup(backend, origin)
      case 'clear_logs': {
        const cleared = await clearAudit(backend)
        if (!cleared) {
          return json(
            { error: 'clear_failed', message: '部分日志删除失败，请稍后重试' },
            500,
            origin,
          )
        }
        await appendAudit(backend, {
          actor: 'admin',
          action: 'clear_logs',
          ip: clientIp(request),
          ua: clientUserAgent(request),
        })
        return json({ ok: true }, 200, origin)
      }
      default:
        return json({ error: 'unknown_action', message: '未知操作' }, 400, origin)
    }
  } catch (err) {
    console.error('[admin] 处理失败', err)
    return json({ error: 'internal_error', message: '服务器处理失败' }, 500, origin)
  }
}

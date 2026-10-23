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
const MAX_IMPORT_RECORDS = 200
const MAX_GET_MANY_KEYS = 200
const MAX_GET_MANY_BYTES = 4 * 1024 * 1024
const MAX_EXPORT_PAGE = 300
const MAX_EXPORT_PAGE_BYTES = 2 * 1024 * 1024
const MAX_EXPORT_KEYS = 50_000
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

async function collectRecordNames(backend: Backend): Promise<string[]> {
  return (await backend.scan('')).filter((name) => !name.startsWith(RESERVED_PREFIX)).sort()
}

async function readKeyRecords(backend: Backend, names: string[]): Promise<KeyRecord[]> {
  const records: KeyRecord[] = []
  for (let index = 0; index < names.length; index += 25) {
    const batch = names.slice(index, index + 25)
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
  return records
}

async function collectRecords(
  backend: Backend,
): Promise<{ records: KeyRecord[]; truncated: boolean }> {
  const names = await collectRecordNames(backend)
  const truncated = names.length > MAX_KEYS
  const records = await readKeyRecords(backend, names.slice(0, MAX_KEYS))
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

/** 数据页分页键列表：只读取当前页，支持超过 1000 条的数据 */
async function handleKeysPage(
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  const names = await collectRecordNames(backend)
  const total = names.length
  const rawOffset = Number(body.offset)
  const rawLimit = Number(body.limit)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  const limit = Number.isFinite(rawLimit)
    ? Math.min(1000, Math.max(1, Math.floor(rawLimit)))
    : 500
  const selected = names.slice(offset, offset + limit)
  const records = await readKeyRecords(backend, selected)
  const nextOffset = offset + selected.length
  return json(
    {
      keys: keysFromRecords(records, false).keys,
      total,
      offset,
      nextOffset,
      hasMore: nextOffset < total,
    },
    200,
    origin,
  )
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

/** 批量读取本地记录（导入时用于准确判断冲突/合并，不受 keys 列表 1000 条上限影响） */
async function handleGetMany(
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    return json({ error: 'bad_request', message: '缺少 keys' }, 400, origin)
  }
  if (body.keys.length > MAX_GET_MANY_KEYS) {
    return json(
      { error: 'too_many_keys', message: `单次最多读取 ${MAX_GET_MANY_KEYS} 个键` },
      413,
      origin,
    )
  }

  const keys = [...new Set(body.keys.filter((key): key is string => isDataKey(key)))]
  const records: {
    key: string
    found: boolean
    value?: unknown
    updatedAt?: number
    size?: number
    legacy?: boolean
  }[] = []
  let bytes = 0

  for (const key of keys) {
    const raw = await backend.read(key)
    if (raw === null) {
      records.push({ key, found: false })
      continue
    }
    const size = byteLength(raw)
    bytes += size
    if (bytes > MAX_GET_MANY_BYTES) {
      return json(
        { error: 'payload_too_large', message: '所选数据过大，请减少数量后重试' },
        413,
        origin,
      )
    }
    const parsed = parseRecord(raw)
    records.push({
      key,
      found: true,
      value: parsed.value ?? null,
      updatedAt: parsed.updatedAt,
      size,
      legacy: parsed.legacy,
    })
  }

  return json({ records, bytes }, 200, origin)
}

/** 大备份分页导出：每页只读取所需值，避免全量读取造成的超时/体积限制 */
async function handleBackupPage(
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  const names = await collectRecordNames(backend)
  const total = names.length
  if (total > MAX_EXPORT_KEYS) {
    return json(
      { error: 'too_many_keys', message: `数据键超过 ${MAX_EXPORT_KEYS} 条，无法一次性导出` },
      413,
      origin,
    )
  }
  const rawOffset = Number(body.offset)
  const rawLimit = Number(body.limit)
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  const limit = Number.isFinite(rawLimit)
    ? Math.min(MAX_EXPORT_PAGE, Math.max(1, Math.floor(rawLimit)))
    : 100
  const selected = names.slice(offset, offset + limit)
  const records: { key: string; value: unknown; updatedAt: number; size: number }[] = []
  let bytes = 0
  let consumed = 0

  for (const key of selected) {
    const raw = await backend.read(key)
    consumed += 1
    if (raw === null) continue
    const size = byteLength(raw)
    if (records.length > 0 && bytes + size > MAX_EXPORT_PAGE_BYTES) {
      consumed -= 1
      break
    }
    bytes += size
    const parsed = parseRecord(raw)
    records.push({ key, value: parsed.value ?? null, updatedAt: parsed.updatedAt, size })
  }

  const nextOffset = offset + consumed
  return json(
    {
      offset,
      nextOffset,
      total,
      hasMore: nextOffset < total,
      bytes,
      records,
    },
    200,
    origin,
  )
}

async function handleImport(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  if (!Array.isArray(body.records) || body.records.length === 0) {
    return json({ error: 'bad_request', message: '缺少导入记录' }, 400, origin)
  }
  if (body.records.length > MAX_IMPORT_RECORDS) {
    return json(
      { error: 'too_many_records', message: `单次最多导入 ${MAX_IMPORT_RECORDS} 条数据` },
      413,
      origin,
    )
  }

  const skipExisting = body.skipExisting === true
  const guardLocal = body.guardLocal === true
  if (body.auditStart === true) {
    await appendAudit(backend, {
      actor: 'admin',
      action: 'import',
      note: `开始从 Classworks 云端批量导入${
        typeof body.totalRecords === 'number' ? `（共 ${Math.floor(body.totalRecords)} 条）` : ''
      }`,
      ip: clientIp(request),
      ua: clientUserAgent(request),
    })
  }
  const records = new Map<
    string,
    { value: unknown; expectedUpdatedAt: number | null | undefined }
  >()
  for (const item of body.records) {
    if (!item || typeof item !== 'object') {
      return json({ error: 'bad_request', message: '导入记录格式错误' }, 400, origin)
    }
    const record = item as {
      key?: unknown
      value?: unknown
      expectedUpdatedAt?: unknown
    }
    if (!isDataKey(record.key) || !('value' in record)) {
      return json({ error: 'bad_request', message: '导入记录缺少合法 key 或 value' }, 400, origin)
    }
    const expected =
      typeof record.expectedUpdatedAt === 'number'
        ? record.expectedUpdatedAt
        : record.expectedUpdatedAt === null
          ? null
          : undefined
    records.set(record.key, { value: record.value, expectedUpdatedAt: expected })
  }

  const imported: { key: string; updatedAt: number; size: number }[] = []
  const skipped: string[] = []
  const failed: { key: string; message: string }[] = []
  let totalBytes = 0

  for (const [key, record] of records) {
    try {
      const existing = await backend.read(key)
      if (skipExisting && existing !== null) {
        skipped.push(key)
        continue
      }
      if (guardLocal) {
        if (record.expectedUpdatedAt === null || record.expectedUpdatedAt === undefined) {
          if (existing !== null) {
            failed.push({ key, message: '本地数据在预览后已被修改，未写入' })
            continue
          }
        } else if (existing === null) {
          failed.push({ key, message: '本地数据已被删除，未写入' })
          continue
        } else {
          const current = parseRecord(existing)
          if (current.updatedAt !== record.expectedUpdatedAt) {
            failed.push({ key, message: '本地数据在预览后已被修改，未写入' })
            continue
          }
        }
      }
      const stored: StoredRecord = { v: record.value, t: Date.now() }
      const serialized = JSON.stringify(stored)
      const size = byteLength(serialized)
      if (size > MAX_VALUE_BYTES) {
        failed.push({ key, message: '数据超过 1MB' })
        continue
      }
      await backend.write(key, serialized)
      totalBytes += size
      imported.push({ key, updatedAt: stored.t, size })
    } catch (err) {
      console.error('[admin] 导入写入失败', key, err)
      failed.push({ key, message: '写入失败' })
    }
  }

  if (body.silent !== true && (imported.length > 0 || failed.length > 0)) {
    await appendAudit(backend, {
      actor: 'admin',
      action: 'import',
      note: `从 Classworks 云端导入 ${imported.length} 条${
        skipped.length ? `，跳过 ${skipped.length} 条` : ''
      }${failed.length ? `，失败 ${failed.length} 条` : ''}`,
      size: totalBytes,
      ip: clientIp(request),
      ua: clientUserAgent(request),
    })
  }

  return json(
    {
      imported,
      skipped,
      failed,
      total: records.size,
      bytes: totalBytes,
    },
    200,
    origin,
  )
}

/** 分批导入结束后写一条汇总日志，避免大导入刷满操作日志 */
async function handleImportSummary(
  request: Request,
  backend: Backend,
  body: Record<string, unknown>,
  origin?: string,
): Promise<Response> {
  const imported = Math.max(0, Math.floor(Number(body.imported) || 0))
  const skipped = Math.max(0, Math.floor(Number(body.skipped) || 0))
  const failed = Math.max(0, Math.floor(Number(body.failed) || 0))
  const bytes = Math.max(0, Math.floor(Number(body.bytes) || 0))
  if (imported + skipped + failed === 0) {
    return json({ ok: true, skippedLog: true }, 200, origin)
  }
  await appendAudit(backend, {
    actor: 'admin',
    action: 'import',
    note: `从 Classworks 云端导入 ${imported} 条${
      skipped ? `，跳过 ${skipped} 条` : ''
    }${failed ? `，失败 ${failed} 条` : ''}${body.cancelled === true ? '（已取消）' : ''}`,
    size: bytes,
    ip: clientIp(request),
    ua: clientUserAgent(request),
  })
  return json({ ok: true }, 200, origin)
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
      case 'keys_page':
        return await handleKeysPage(backend, body, origin)
      case 'overview':
        return await handleOverview(backend, origin)
      case 'get':
        return await handleGet(backend, body, origin)
      case 'put':
        return await handlePut(request, backend, body, origin)
      case 'delete':
        return await handleDelete(request, backend, body, origin)
      case 'import':
        return await handleImport(request, backend, body, origin)
      case 'import_summary':
        return await handleImportSummary(request, backend, body, origin)
      case 'get_many':
        return await handleGetMany(backend, body, origin)
      case 'backup_page':
        return await handleBackupPage(backend, body, origin)
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

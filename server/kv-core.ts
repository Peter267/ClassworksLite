/**
 * 与平台无关的 KV 接口实现。
 *
 * 同一个处理器被三种运行时复用：
 *  - Cloudflare Pages Functions（functions/api/kv.ts）
 *  - Cloudflare Workers（worker/index.ts）
 *  - Vercel / Node（api/kv.ts、server/dev-kv-plugin.ts）
 *
 * 存储层只需要实现 Backend：读取、写入、删除、按前缀列出。
 */

import { appendAudit, clientIp, clientUserAgent } from './audit'
import { authorizeAccess } from './auth-core'

export interface StoredRecord {
  /** 业务数据本身 */
  v: unknown
  /** 写入时间戳（毫秒） */
  t: number
}

/** __ 前缀留给管理后台（日志、限流状态），普通接口不可读写 */
const RESERVED_PREFIX = '__'

export interface Backend {
  read(key: string): Promise<string | null>
  write(key: string, raw: string): Promise<void>
  remove(key: string): Promise<void>
  scan(prefix: string): Promise<string[]>
}

export interface HandlerOptions {
  /** 只读密码；配置后读取需要 /api/auth 签发的令牌 */
  viewPassword?: string
  /** 可写密码；配置后写入 / 删除需要可写令牌 */
  editPassword?: string
  /** 访问令牌签名密钥，留空时由两个密码派生 */
  authSecret?: string
  /** 允许跨域的来源，默认 * */
  corsOrigin?: string
}

const MAX_KEY_LENGTH = 200
const MAX_BODY_BYTES = 1_000_000
const MAX_PREFIX_KEYS = 500
const encoder = new TextEncoder()

const deniedAuditAt = new Map<string, number>()

/** 未授权请求不逐条写审计，避免匿名流量耗尽 KV 写额度 */
function shouldAuditDenied(ip: string): boolean {
  const now = Date.now()
  const last = deniedAuditAt.get(ip) ?? 0
  if (now - last < 60_000) return false
  deniedAuditAt.set(ip, now)
  if (deniedAuditAt.size > 2000) {
    for (const [key, at] of deniedAuditAt) {
      if (now - at > 60_000) deniedAuditAt.delete(key)
    }
  }
  return true
}

const CORS_HEADERS = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
})

function json(data: unknown, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS(origin),
    },
  })
}

function validKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    !key.startsWith(RESERVED_PREFIX) &&
    !/[\u0000-\u001f\u007f]/.test(key)
  )
}

/**
 * 宽容解析：标准记录是 { v, t }；迁移期可能遇到直接存放 JSON 值或原始字符串的旧键。
 * 管理后台已经兼容这两种形式，站点读取也应保持一致。
 */
function parseStoredRecord(raw: string): StoredRecord {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && 'v' in parsed) {
      const record = parsed as Partial<StoredRecord>
      return {
        v: record.v,
        t: typeof record.t === 'number' ? record.t : 0,
      }
    }
    return { v: parsed, t: 0 }
  } catch {
    return { v: raw, t: 0 }
  }
}

export async function handleKV(
  request: Request,
  backend: Backend,
  options: HandlerOptions = {},
): Promise<Response> {
  const origin = options.corsOrigin ?? '*'
  // HandlerOptions 沿用 authSecret，校验函数统一使用 secret
  const access = {
    viewPassword: options.viewPassword,
    editPassword: options.editPassword,
    secret: options.authSecret,
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS(origin) })
  }

  const ip = clientIp(request)
  const ua = clientUserAgent(request)

  const role = await authorizeAccess(request, access)
  if (!role) {
    if (shouldAuditDenied(ip)) {
      await appendAudit(backend, {
        actor: 'site',
        action: 'denied',
        ip,
        ua,
        note: options.viewPassword || options.editPassword ? '缺少或过期的访问令牌' : '访问令牌无效',
      })
    }
    return json({ error: 'unauthorized', message: '需要访问授权' }, 401, origin)
  }

  const isWrite = request.method === 'PUT' || request.method === 'DELETE'
  if (isWrite && role !== 'edit') {
    if (shouldAuditDenied(ip)) {
      await appendAudit(backend, {
        actor: 'site',
        action: 'denied',
        ip,
        ua,
        note: '只读令牌尝试写入',
      })
    }
    return json(
      { error: 'read_only', message: '当前为只读访问，无法修改作业' },
      403,
      origin,
    )
  }

  const url = new URL(request.url)
  const key = url.searchParams.get('key')
  const prefix = url.searchParams.get('prefix')

  try {
    if (request.method === 'GET') {
      if (prefix !== null) {
        const keys = (await backend.scan(prefix)).filter(
          (name) => !name.startsWith(RESERVED_PREFIX),
        )
        const selected = keys.slice(0, MAX_PREFIX_KEYS)
        const detailed: { key: string; updatedAt: number }[] = []
        // 分批读取，避免一次请求同时发起数百个 KV 读
        for (let index = 0; index < selected.length; index += 25) {
          const batch = selected.slice(index, index + 25)
          const items = await Promise.all(
            batch.map(async (name) => {
              const raw = await backend.read(name)
              return {
                key: name,
                updatedAt: raw ? parseStoredRecord(raw).t : 0,
              }
            }),
          )
          detailed.push(...items)
        }
        return json(
          { keys: detailed, truncated: keys.length > MAX_PREFIX_KEYS },
          200,
          origin,
        )
      }

      if (!validKey(key)) {
        return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
      }

      const raw = await backend.read(key)
      if (raw === null) return json({ error: 'not_found', key }, 404, origin)

      const record = parseStoredRecord(raw)
      return json({ key, value: record.v, updatedAt: record.t }, 200, origin)
    }

    if (request.method === 'PUT') {
      const text = await request.text()
      if (encoder.encode(text).byteLength > MAX_BODY_BYTES) {
        return json({ error: 'payload_too_large', message: '数据超过 1MB' }, 413, origin)
      }

      let body: {
        key?: unknown
        value?: unknown
        baseUpdatedAt?: unknown
      }
      try {
        body = JSON.parse(text) as typeof body
      } catch {
        return json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400, origin)
      }

      if (!validKey(body.key) || !('value' in body)) {
        return json({ error: 'bad_request', message: '缺少 key 或 value' }, 400, origin)
      }

      if ('baseUpdatedAt' in body) {
        const base = body.baseUpdatedAt
        if (base !== null && typeof base !== 'number') {
          return json({ error: 'bad_request', message: '数据版本信息非法' }, 400, origin)
        }
        const existing = await backend.read(body.key)
        if (existing === null) {
          if (base !== null) {
            return json(
              { error: 'conflict', message: '数据已被删除，请刷新后重试' },
              409,
              origin,
            )
          }
        } else {
          const current = parseStoredRecord(existing)
          if (base === null || base !== current.t) {
            return json(
              {
                error: 'conflict',
                message: '数据已被其他设备修改，请刷新后重试',
                updatedAt: current.t,
              },
              409,
              origin,
            )
          }
        }
      }

      const record: StoredRecord = { v: body.value, t: Date.now() }
      await backend.write(body.key, JSON.stringify(record))
      await appendAudit(backend, {
        actor: 'site',
        action: 'write',
        key: body.key,
        size: encoder.encode(text).byteLength,
        ip: clientIp(request),
        ua: clientUserAgent(request),
      })
      return json({ key: body.key, updatedAt: record.t }, 200, origin)
    }

    if (request.method === 'DELETE') {
      if (!validKey(key)) {
        return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
      }
      await backend.remove(key)
      await appendAudit(backend, {
        actor: 'site',
        action: 'delete',
        key,
        ip: clientIp(request),
        ua: clientUserAgent(request),
      })
      return json({ ok: true, key }, 200, origin)
    }

    return json({ error: 'method_not_allowed' }, 405, origin)
  } catch (err) {
    console.error('[kv] 处理失败', err)
    return json({ error: 'internal_error', message: '服务器处理失败' }, 500, origin)
  }
}

export function healthResponse(origin = '*') {
  return json({ ok: true, service: 'classworks-lite-kv', ts: Date.now() }, 200, origin)
}

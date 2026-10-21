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
import { isEditAuthorized, isViewAuthorized } from './auth-core'

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
  /** 旧版静态访问令牌；为空表示不校验 */
  siteToken?: string
  /** 站点访问密码；配置后读取需要 /api/auth 签发的令牌 */
  sitePassword?: string
  /** 访问令牌签名密钥，留空时使用 SITE_PASSWORD */
  authSecret?: string
  /** 编辑令牌；配置后写入 / 删除需要 X-Edit-Token */
  editToken?: string
  /** 允许跨域的来源，默认 * */
  corsOrigin?: string
}

const MAX_KEY_LENGTH = 200
const MAX_BODY_BYTES = 1_000_000

const CORS_HEADERS = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Site-Key, X-Edit-Token',
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

export async function handleKV(
  request: Request,
  backend: Backend,
  options: HandlerOptions = {},
): Promise<Response> {
  const origin = options.corsOrigin ?? '*'
  // HandlerOptions 沿用 authSecret，校验函数统一使用 secret
  const access = {
    sitePassword: options.sitePassword,
    editToken: options.editToken,
    siteToken: options.siteToken,
    secret: options.authSecret,
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS(origin) })
  }

  if (!(await isViewAuthorized(request, access))) {
    await appendAudit(backend, {
      actor: 'site',
      action: 'denied',
      ip: clientIp(request),
      ua: clientUserAgent(request),
      note: options.sitePassword ? '缺少或过期的访问令牌' : '站点令牌无效',
    })
    return json({ error: 'unauthorized', message: '需要访问授权' }, 401, origin)
  }

  if (
    (request.method === 'PUT' || request.method === 'DELETE') &&
    !(await isEditAuthorized(request, access))
  ) {
    await appendAudit(backend, {
      actor: 'site',
      action: 'denied',
      ip: clientIp(request),
      ua: clientUserAgent(request),
      note: '编辑令牌无效',
    })
    return json(
      { error: 'edit_token_required', message: '需要有效的编辑令牌才能修改作业' },
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
        const detailed = await Promise.all(
          keys.slice(0, 500).map(async (name) => {
            const raw = await backend.read(name)
            let updatedAt = 0
            try {
              updatedAt = raw ? ((JSON.parse(raw) as StoredRecord).t ?? 0) : 0
            } catch {
              updatedAt = 0
            }
            return { key: name, updatedAt }
          }),
        )
        return json({ keys: detailed }, 200, origin)
      }

      if (!validKey(key)) {
        return json({ error: 'bad_request', message: '缺少或非法的 key' }, 400, origin)
      }

      const raw = await backend.read(key)
      if (raw === null) return json({ error: 'not_found', key }, 404, origin)

      const record = JSON.parse(raw) as StoredRecord
      return json({ key, value: record.v, updatedAt: record.t }, 200, origin)
    }

    if (request.method === 'PUT') {
      const text = await request.text()
      if (text.length > MAX_BODY_BYTES) {
        return json({ error: 'payload_too_large', message: '数据超过 1MB' }, 413, origin)
      }

      let body: { key?: unknown; value?: unknown }
      try {
        body = JSON.parse(text) as { key?: unknown; value?: unknown }
      } catch {
        return json({ error: 'bad_request', message: '请求体不是合法 JSON' }, 400, origin)
      }

      if (!validKey(body.key) || !('value' in body)) {
        return json({ error: 'bad_request', message: '缺少 key 或 value' }, 400, origin)
      }

      const record: StoredRecord = { v: body.value, t: Date.now() }
      await backend.write(body.key, JSON.stringify(record))
      await appendAudit(backend, {
        actor: 'site',
        action: 'write',
        key: body.key,
        size: text.length,
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
    return json(
      { error: 'internal_error', message: err instanceof Error ? err.message : '未知错误' },
      500,
      origin,
    )
  }
}

export function healthResponse(origin = '*') {
  return json({ ok: true, service: 'classworks-lite-kv', ts: Date.now() }, 200, origin)
}

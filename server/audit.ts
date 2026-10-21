/**
 * 审计日志：只记录写操作与登录事件，避免读请求放大 KV 读写次数。
 *
 * 新格式为“一条日志一个键”，键名以时间戳开头，因此追加日志不需要先读整份历史，
 * 也不会因为并发读改写互相覆盖。旧版本保存在 __admin-logs 的数组仍会被读取。
 */
import type { Backend } from './kv-core'

export const AUDIT_KEY = '__admin-logs'
export const AUDIT_PREFIX = '__audit:'
export const AUDIT_LIMIT = 500

export type AuditActor = 'admin' | 'site'
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'write'
  | 'delete'
  | 'clear_logs'
  | 'denied'

export interface AuditEntry {
  id: string
  at: number
  actor: AuditActor
  action: AuditAction
  key?: string
  ip?: string
  ua?: string
  size?: number
  note?: string
}

function isEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<AuditEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    typeof entry.actor === 'string' &&
    typeof entry.action === 'string'
  )
}

export function clientIp(request: Request): string {
  // Cloudflare 会覆盖 cf-connecting-ip；Vercel 会覆盖 x-forwarded-for。
  // 对追加式 XFF 取最后一跳，避免客户端自行拼接的第一个值。
  const forwarded = request.headers.get('x-forwarded-for')
  const header =
    request.headers.get('cf-connecting-ip') ||
    (forwarded
      ? forwarded
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .pop()
      : request.headers.get('x-real-ip'))
  return header || '未知'
}

export function clientUserAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 180)
}

function entryKey(at: number, id: string) {
  return `${AUDIT_PREFIX}${String(at).padStart(13, '0')}-${id}`
}

function parseEntry(raw: string): AuditEntry | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isEntry(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function readLegacyAudit(backend: Backend): Promise<AuditEntry[]> {
  try {
    const raw = await backend.read(AUDIT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    return []
  }
}

export async function readAudit(backend: Backend): Promise<AuditEntry[]> {
  const names = await backend.scan(AUDIT_PREFIX)
  names.sort()
  if (names.length > AUDIT_LIMIT) {
    const stale = names.slice(0, names.length - AUDIT_LIMIT)
    await Promise.all(stale.map((name) => backend.remove(name))).catch((err) => {
      console.warn('[audit] 读取时清理旧日志失败', err)
    })
  }
  const selected = names.slice(-AUDIT_LIMIT)
  const entries: AuditEntry[] = []
  for (let index = 0; index < selected.length; index += 25) {
    const batch = selected.slice(index, index + 25)
    const items = await Promise.all(
      batch.map(async (name) => {
        try {
          const raw = await backend.read(name)
          return raw ? parseEntry(raw) : null
        } catch (err) {
          console.warn('[audit] 读取单条日志失败', name, err)
          return null
        }
      }),
    )
    for (const item of items) if (item) entries.push(item)
  }
  entries.push(...(await readLegacyAudit(backend)))
  return entries.sort((a, b) => b.at - a.at).slice(0, AUDIT_LIMIT)
}

async function pruneAudit(backend: Backend): Promise<void> {
  try {
    const names = (await backend.scan(AUDIT_PREFIX)).sort()
    if (names.length <= AUDIT_LIMIT) return
    const stale = names.slice(0, names.length - AUDIT_LIMIT)
    await Promise.all(stale.map((name) => backend.remove(name)))
  } catch (err) {
    console.warn('[audit] 清理旧日志失败', err)
  }
}

let auditWrites = 0

export async function appendAudit(
  backend: Backend,
  entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number },
): Promise<void> {
  try {
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const at = entry.at ?? Date.now()
    const next: AuditEntry = { ...entry, id, at }
    await backend.write(entryKey(at, id), JSON.stringify(next))
    auditWrites += 1
    // 定期清理，等待完成以免 Serverless 在响应返回后取消后台任务
    if (auditWrites % 10 === 0) await pruneAudit(backend)
  } catch (err) {
    console.warn('[audit] 写入日志失败', err)
  }
}

export async function clearAudit(backend: Backend): Promise<boolean> {
  try {
    const names = await backend.scan(AUDIT_PREFIX)
    await Promise.all(names.map((name) => backend.remove(name)))
    await backend.remove(AUDIT_KEY)
    return true
  } catch (err) {
    console.warn('[audit] 清空日志失败', err)
    return false
  }
}

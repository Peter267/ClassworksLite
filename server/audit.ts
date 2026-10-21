/**
 * 审计日志：只记录写操作与登录事件，避免读请求放大 KV 读写次数。
 *
 * 日志存放在保留键 __admin-logs 中，普通 /api/kv 接口无法读写 __ 前缀的键。
 */
import type { Backend } from './kv-core'

export const AUDIT_KEY = '__admin-logs'
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
  const forwarded = request.headers.get('x-forwarded-for')
  const header =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-real-ip') ||
    (forwarded ? forwarded.split(',')[0].trim() : '')
  return header || '未知'
}

export function clientUserAgent(request: Request): string {
  return (request.headers.get('user-agent') ?? '').slice(0, 180)
}

export async function readAudit(backend: Backend): Promise<AuditEntry[]> {
  try {
    const raw = await backend.read(AUDIT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

export async function appendAudit(
  backend: Backend,
  entry: Omit<AuditEntry, 'id' | 'at'> & { at?: number },
): Promise<void> {
  try {
    const logs = await readAudit(backend)
    const bytes = new Uint8Array(4)
    crypto.getRandomValues(bytes)
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const next: AuditEntry[] = [{ ...entry, id, at: entry.at ?? Date.now() }, ...logs].slice(
      0,
      AUDIT_LIMIT,
    )
    await backend.write(AUDIT_KEY, JSON.stringify(next))
  } catch (err) {
    console.warn('[audit] 写入日志失败', err)
  }
}

export async function clearAudit(backend: Backend): Promise<void> {
  try {
    await backend.remove(AUDIT_KEY)
  } catch (err) {
    console.warn('[audit] 清空日志失败', err)
  }
}

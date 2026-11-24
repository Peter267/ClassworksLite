/**
 * 本地备份文件导入。
 *
 * 与「导出全站备份」的产物一一对应：
 *   { exportedAt, count, bytes, data: { [key]: { value, updatedAt } } }
 * 同时兼容两种简化写法，便于手工整理或旧备份迁移：
 *   { data: { [key]: value } }
 *   { [key]: value }
 *
 * 只做解析、校验与计划，不直接读写 KV；落盘走 adminApi.importRecords，
 * 由服务端复用 /api/kv 的同一套键名校验与 1 MB 单条限制。
 */
import {
  classifyKey,
  importLabelFor,
  isValidRemoteKey,
  summarizeValue,
  type ImportCategory,
  type ImportRecord,
  type LocalRecord,
} from './upstreamImport'

export const MAX_BACKUP_BYTES = 200 * 1024 * 1024
export const MAX_BACKUP_RECORDS = 50_000
/** 与服务端 MAX_VALUE_BYTES 一致 */
export const MAX_BACKUP_VALUE_BYTES = 1_000_000

export type BackupStrategy = 'overwrite' | 'skip'
export type BackupAction = 'new' | 'overwrite' | 'skip' | 'error'

export class BackupParseError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(issues.join('；'))
    this.name = 'BackupParseError'
    this.issues = issues
  }
}

export interface BackupRecord {
  key: string
  value: unknown
  updatedAt: number
}

export interface ParsedBackup {
  fileName: string
  bytes: number
  exportedAt: number | null
  declaredCount: number | null
  declaredBytes: number | null
  records: BackupRecord[]
  warnings: string[]
}

export interface BackupPlanRow {
  key: string
  category: ImportCategory
  label: string
  action: BackupAction
  localExists: boolean
  localUpdatedAt?: number
  backupUpdatedAt: number
  size: number
  summary: string
  warnings: string[]
  reason?: string
  value?: unknown
}

export interface BackupPlan {
  rows: BackupPlanRow[]
  counts: Record<BackupAction, number>
  totalBytes: number
  warningCount: number
  records: ImportRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function asCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value)
  }
  return null
}

/** 与服务端落盘口径一致：{"v": value, "t": 时间戳} */
export function estimateStoredBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify({ v: value, t: 1_700_000_000_000 }))
      .byteLength
  } catch {
    return 0
  }
}

const ENTRY_KEYS = new Set(['value', 'updatedAt'])

/** 识别 { value, updatedAt } 记录外壳；其余一律按原始值处理 */
function unwrapEntry(entry: unknown): { value: unknown; updatedAt: number } | null {
  if (!isRecord(entry) || !('value' in entry)) return null
  if (!Object.keys(entry).every((key) => ENTRY_KEYS.has(key))) return null
  return { value: entry.value, updatedAt: asTimestamp(entry.updatedAt) }
}

export function parseBackup(text: string, fileName = '', bytes = 0): ParsedBackup {
  if (!text.trim()) throw new BackupParseError(['备份文件是空的'])
  if (bytes > MAX_BACKUP_BYTES) {
    throw new BackupParseError([
      `备份文件超过 ${Math.floor(MAX_BACKUP_BYTES / 1024 / 1024)} MB，请拆分后再导入`,
    ])
  }

  let root: unknown
  try {
    root = JSON.parse(text) as unknown
  } catch (err) {
    throw new BackupParseError([
      `不是合法的 JSON 文件${err instanceof Error ? `：${err.message}` : ''}`,
    ])
  }

  if (!isRecord(root)) {
    throw new BackupParseError(['备份文件的顶层结构必须是对象'])
  }

  const warnings: string[] = []
  const envelope =
    isRecord(root.data) &&
    ['exportedAt', 'count', 'bytes', 'version'].some((field) => field in root)
  if ('data' in root && root.data !== null && !isRecord(root.data)) {
    throw new BackupParseError(['备份文件的 data 字段必须是对象'])
  }

  const body = (envelope ? (root.data as Record<string, unknown>) : root) ?? {}
  const exportedAt = asTimestamp(root.exportedAt)
  const declaredCount = asCount(root.count)
  const declaredBytes = asCount(root.bytes)

  const records: BackupRecord[] = []
  for (const [key, entry] of Object.entries(body)) {
    const wrapped = unwrapEntry(entry)
    if (wrapped) {
      records.push({ key, value: wrapped.value, updatedAt: wrapped.updatedAt })
    } else {
      records.push({ key, value: entry, updatedAt: 0 })
    }
    if (records.length > MAX_BACKUP_RECORDS) break
  }

  if (records.length > MAX_BACKUP_RECORDS) {
    throw new BackupParseError([
      `单个备份最多导入 ${MAX_BACKUP_RECORDS.toLocaleString('zh-CN')} 条数据，请拆分后再导入`,
    ])
  }
  if (records.length === 0) {
    throw new BackupParseError(['备份文件中没有可导入的数据键'])
  }
  if (declaredCount !== null && declaredCount !== records.length) {
    warnings.push(`文件声明 ${declaredCount} 条，实际解析到 ${records.length} 条`)
  }
  if (!exportedAt) warnings.push('文件未记录导出时间')

  records.sort((a, b) => a.key.localeCompare(b.key))
  return {
    fileName,
    bytes,
    exportedAt: exportedAt || null,
    declaredCount,
    declaredBytes,
    records,
    warnings,
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export function buildBackupPlan(
  parsed: ParsedBackup,
  localRecords: Map<string, LocalRecord>,
  strategy: BackupStrategy,
): BackupPlan {
  const rows: BackupPlanRow[] = []
  const counts: Record<BackupAction, number> = { new: 0, overwrite: 0, skip: 0, error: 0 }
  let totalBytes = 0
  let warningCount = 0

  for (const record of parsed.records) {
    const { key, value, updatedAt } = record
    const category = classifyKey(key)
    const label = importLabelFor(key)
    const local = localRecords.get(key)
    const localExists = Boolean(local)
    const warnings: string[] = []
    const push = (row: BackupPlanRow) => {
      counts[row.action] += 1
      warningCount += row.warnings.length
      if (row.action !== 'skip' && row.action !== 'error') totalBytes += row.size
      rows.push(row)
    }

    if (!isValidRemoteKey(key)) {
      push({
        key,
        category,
        label,
        action: 'error',
        localExists,
        localUpdatedAt: local?.updatedAt,
        backupUpdatedAt: updatedAt,
        size: 0,
        summary: '键名不合法',
        warnings,
        reason: '键名不能为空、不能以 __ 开头、长度不超过 200 且不能包含控制字符',
      })
      continue
    }

    const size = estimateStoredBytes(value)
    if (size > MAX_BACKUP_VALUE_BYTES) {
      push({
        key,
        category,
        label,
        action: 'error',
        localExists,
        localUpdatedAt: local?.updatedAt,
        backupUpdatedAt: updatedAt,
        size,
        summary: summarizeValue(category, value),
        warnings,
        reason: '单条记录超过 1 MB 上限，无法写入',
      })
      continue
    }

    if (local && strategy === 'skip') {
      push({
        key,
        category,
        label,
        action: 'skip',
        localExists,
        localUpdatedAt: local.updatedAt,
        backupUpdatedAt: updatedAt,
        size,
        summary: summarizeValue(category, value),
        warnings,
        reason: '本地已存在该键，按策略保留本地',
      })
      continue
    }
    if (local && sameJson(local.value, value)) {
      push({
        key,
        category,
        label,
        action: 'skip',
        localExists,
        localUpdatedAt: local.updatedAt,
        backupUpdatedAt: updatedAt,
        size,
        summary: summarizeValue(category, value),
        warnings,
        reason: '与本地内容一致，无需写入',
      })
      continue
    }

    push({
      key,
      category,
      label,
      action: localExists ? 'overwrite' : 'new',
      localExists,
      localUpdatedAt: local?.updatedAt,
      backupUpdatedAt: updatedAt,
      size,
      summary: summarizeValue(category, value),
      warnings,
      reason: localExists ? '用备份内容替换本地同键数据' : '本地不存在该键',
      value,
    })
  }

  const records = rows
    .filter(
      (row) =>
        (row.action === 'new' || row.action === 'overwrite') && row.value !== undefined,
    )
    .map((row) => ({
      key: row.key,
      value: row.value,
      // 预览后本地再被修改时，服务端按乐观并发拒绝写入，避免覆盖他人在此期间的编辑
      expectedUpdatedAt: row.localExists ? (row.localUpdatedAt ?? null) : null,
    }))

  return { rows, counts, totalBytes, warningCount, records }
}

/** 备份覆盖的数据范围，用于概览展示 */
export function summarizeBackup(parsed: ParsedBackup) {
  let boards = 0
  let config = 0
  let other = 0
  for (const record of parsed.records) {
    const category = classifyKey(record.key)
    if (category === 'board') boards += 1
    else if (category === 'other') other += 1
    else config += 1
  }
  return { boards, config, other }
}

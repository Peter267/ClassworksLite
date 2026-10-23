/**
 * Classworks 上游云端导入。
 *
 * 上游 KV 服务（默认 https://kv-service.wuyuan.dev）：
 *   GET /kv/_info              -> 设备 / 命名空间信息
 *   GET /kv/_token             -> 当前 token 的类型与权限
 *   GET /kv?limit=&skip=       -> 键名与元数据
 *   GET /kv/:key               -> 键值（原始 JSON）
 * 鉴权：x-app-token（新版）或 x-site-key（旧版），也支持 Authorization: Bearer。
 */
import type { BoardData, ExamConfig, HomeworkTemplate, Student, Subject } from './types'

export const DEFAULT_UPSTREAM_SERVER = 'https://kv-service.wuyuan.dev'
export const MAX_UPSTREAM_KEYS = 5000
/** 单次预览的值总量上限，避免超大选择把浏览器内存打满 */
export const MAX_PREVIEW_BYTES = 80 * 1024 * 1024

export type ImportCategory =
  | 'board'
  | 'students'
  | 'subjects'
  | 'exams'
  | 'template'
  | 'noise'
  | 'other'

export type ConflictStrategy = 'merge' | 'overwrite' | 'skip'
export type PlanAction = 'new' | 'overwrite' | 'merge' | 'skip' | 'error'

export interface UpstreamAuth {
  baseUrl: string
  token?: string
  siteKey?: string
}

export interface UpstreamDeviceInfo {
  name?: string
  namespace?: string
  uuid?: string
}

export interface UpstreamTokenInfo {
  deviceType?: string
  isReadOnly?: boolean
  note?: string
  device?: UpstreamDeviceInfo
}

export interface UpstreamConnectionInfo {
  device?: UpstreamDeviceInfo
  hasAccount?: boolean
  account?: { name?: string; avatarUrl?: string }
  token?: UpstreamTokenInfo
  warnings: string[]
}

export interface UpstreamKeyInfo {
  key: string
  updatedAt: number
}

export interface UpstreamKeyList {
  keys: UpstreamKeyInfo[]
  total: number
  truncated: boolean
}

export interface ImportSelection {
  key: string
  category: ImportCategory
  remoteUpdatedAt: number
}

export interface LocalRecord {
  value: unknown
  updatedAt: number
}

export interface ImportPlanRow {
  key: string
  category: ImportCategory
  label: string
  action: PlanAction
  localExists: boolean
  localUpdatedAt?: number
  remoteUpdatedAt: number
  size: number
  summary: string
  warnings: string[]
  reason?: string
  value?: unknown
}

export interface ImportRecord {
  key: string
  value: unknown
  /** 合并/覆盖前预览到的本地更新时间；null 表示预期本地不存在 */
  expectedUpdatedAt?: number | null
}

export interface ImportPlan {
  rows: ImportPlanRow[]
  counts: Record<PlanAction, number>
  totalBytes: number
  warningCount: number
  records: ImportRecord[]
}

export interface ValueLoadResult {
  values: Map<string, unknown>
  errors: Map<string, string>
}

export class UpstreamError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
  }
}

const CONFIG_DEFINITIONS: Record<
  string,
  { category: ImportCategory; label: string; description: string }
> = {
  'classworks-list-main': {
    category: 'students',
    label: '花名册',
    description: '学生名单，按姓名去重合并',
  },
  'classworks-config-subject': {
    category: 'subjects',
    label: '科目配置',
    description: '科目与排序，补充本地缺失科目',
  },
  'classworks-exams': {
    category: 'exams',
    label: '考试配置',
    description: '考试场次，按 id 去重合并',
  },
  'classworks-config-homework-template': {
    category: 'template',
    label: '作业模板',
    description: '按科目分组的常用作业模板',
  },
  'noise-session-config': {
    category: 'noise',
    label: '噪音时段',
    description: '晚自习时段与报警阈值',
  },
}

export const IMPORT_CATEGORY_LABELS: Record<ImportCategory, string> = {
  board: '作业数据',
  students: '花名册',
  subjects: '科目',
  exams: '考试',
  template: '作业模板',
  noise: '噪音时段',
  other: '其他数据',
}

/* ------------------------------------------------------------------ */
/* 连接与请求                                                          */
/* ------------------------------------------------------------------ */

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new UpstreamError(0, 'bad_url', '请填写云端服务地址')
  const explicitScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  if (explicitScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new UpstreamError(0, 'bad_url', '仅支持 http / https 地址')
  }
  let url: URL
  try {
    url = new URL(explicitScheme ? trimmed : `https://${trimmed}`)
  } catch {
    throw new UpstreamError(0, 'bad_url', '云端服务地址格式不正确')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError(0, 'bad_url', '仅支持 http / https 地址')
  }
  if (url.username || url.password) {
    throw new UpstreamError(0, 'bad_url', '请勿在地址中直接填写账号密码')
  }
  url.hash = ''
  url.search = ''
  return url.toString().replace(/\/+$/, '')
}

export function upstreamHeaders(auth: UpstreamAuth): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (auth.token) {
    headers['x-app-token'] = auth.token
    // 兼容部分只接受 Authorization 的部署
    headers.Authorization = `Bearer ${auth.token}`
  }
  if (auth.siteKey) headers['x-site-key'] = auth.siteKey
  return headers
}

function friendlyHttpError(status: number, message?: string): UpstreamError {
  if (status === 401) return new UpstreamError(401, 'unauthorized', 'Token 无效或已过期，请重新获取')
  if (status === 403) return new UpstreamError(403, 'forbidden', '该 Token 无权访问此命名空间')
  if (status === 404) return new UpstreamError(404, 'not_found', '云端资源不存在')
  if (status === 429) return new UpstreamError(429, 'rate_limited', '云端请求过于频繁，请稍后重试')
  if (status >= 500) return new UpstreamError(status, 'server_error', '云端服务异常，请稍后重试')
  return new UpstreamError(status, 'request_failed', message || `云端返回 ${status}`)
}

async function requestJson(
  auth: UpstreamAuth,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(auth.baseUrl)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'GET',
        headers: upstreamHeaders(auth),
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      })
      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (response.status === 429 && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)))
        continue
      }
      if (!response.ok) {
        const body = (payload ?? {}) as {
          error?: string | { message?: string }
          message?: string
        }
        const message =
          body.message ??
          (typeof body.error === 'string' ? body.error : body.error?.message) ??
          undefined
        throw friendlyHttpError(response.status, message)
      }
      return payload
    } catch (err) {
      if (err instanceof UpstreamError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new UpstreamError(0, 'timeout', '连接云端超时，请检查地址与网络')
      }
      throw new UpstreamError(
        0,
        'network_error',
        '无法连接云端服务：请检查服务地址、网络，或该服务是否允许当前站点跨域访问',
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  throw new UpstreamError(429, 'rate_limited', '云端请求过于频繁，请稍后重试')
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

function assertUpstreamSuccess(payload: unknown) {
  if (isRecord(payload) && payload.success === false) {
    const error = payload.error as { code?: string; message?: string } | undefined
    throw new UpstreamError(0, error?.code ?? 'upstream_error', error?.message ?? '云端返回错误')
  }
}

export async function fetchUpstreamConnectionInfo(
  auth: UpstreamAuth,
  signal?: AbortSignal,
): Promise<UpstreamConnectionInfo> {
  const warnings: string[] = []
  let info: Record<string, unknown> | null = null
  let tokenInfo: Record<string, unknown> | null = null

  try {
    const raw = await requestJson(auth, '/kv/_info', signal)
    assertUpstreamSuccess(raw)
    info = isRecord(raw) ? raw : null
  } catch (err) {
    if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) throw err
    warnings.push('未能读取命名空间信息，将以键列表验证连接')
  }

  try {
    const raw = await requestJson(auth, '/kv/_token', signal)
    assertUpstreamSuccess(raw)
    tokenInfo = isRecord(raw) ? raw : null
  } catch (err) {
    if (err instanceof UpstreamError && (err.status === 401 || err.status === 403)) throw err
    if (!(err instanceof UpstreamError && err.status === 404)) {
      warnings.push('未能读取 Token 详情')
    }
  }

  const device = isRecord(info?.device) ? (info.device as UpstreamDeviceInfo) : undefined
  const account = isRecord(info?.account)
    ? (info.account as { name?: string; avatarUrl?: string })
    : undefined
  const tokenDevice = isRecord(tokenInfo?.device)
    ? (tokenInfo.device as UpstreamDeviceInfo)
    : undefined

  return {
    device: device ?? tokenDevice,
    hasAccount: info?.hasAccount === true,
    account,
    token: tokenInfo
      ? {
          deviceType:
            typeof tokenInfo.deviceType === 'string' ? tokenInfo.deviceType : undefined,
          isReadOnly: tokenInfo.isReadOnly === true,
          note: typeof tokenInfo.note === 'string' ? tokenInfo.note : undefined,
          device: tokenDevice,
        }
      : undefined,
    warnings,
  }
}

export async function fetchUpstreamKeys(
  auth: UpstreamAuth,
  signal?: AbortSignal,
): Promise<UpstreamKeyList> {
  const collected = new Map<string, number>()
  let total = 0
  let recognized = false
  const pageSize = 200

  for (let skip = 0; skip < MAX_UPSTREAM_KEYS; skip += pageSize) {
    const payload = await requestJson(
      auth,
      `/kv?sortBy=key&sortDir=asc&limit=${pageSize}&skip=${skip}`,
      signal,
    )
    assertUpstreamSuccess(payload)
    const record = isRecord(payload) ? payload : null
    const items = Array.isArray(record?.items)
      ? record.items
      : Array.isArray(record?.keys)
        ? record.keys
        : Array.isArray(payload)
          ? payload
          : null
    if (!items) break
    recognized = true
    const pageTotal = Number(record?.total_rows)
    total = Math.max(total, Number.isFinite(pageTotal) ? pageTotal : 0, collected.size + items.length)
    for (const item of items) {
      if (typeof item === 'string') {
        collected.set(item, 0)
      } else if (isRecord(item) && typeof item.key === 'string') {
        const meta = isRecord(item.metadata) ? item.metadata : null
        const updatedAt =
          asTimestamp(meta?.updatedAt) || asTimestamp(item.updatedAt) || asTimestamp(item.t)
        collected.set(item.key, updatedAt)
      }
    }
    if (
      items.length < pageSize ||
      (Number.isFinite(pageTotal) && pageTotal > 0 && skip + items.length >= pageTotal)
    ) {
      break
    }
  }

  if (!recognized) {
    // 兼容仅暴露 /kv/_keys 的旧版服务
    for (let skip = 0; skip < MAX_UPSTREAM_KEYS; skip += pageSize) {
      const payload = await requestJson(
        auth,
        `/kv/_keys?sortBy=key&sortDir=asc&limit=${pageSize}&skip=${skip}`,
        signal,
      )
      assertUpstreamSuccess(payload)
      const record = isRecord(payload) ? payload : null
      const keys = Array.isArray(record?.keys) ? record.keys : Array.isArray(payload) ? payload : null
      if (!keys) break
      const pageTotal = Number(record?.total_rows)
      total = Math.max(total, Number.isFinite(pageTotal) ? pageTotal : 0, collected.size + keys.length)
      for (const key of keys) {
        if (typeof key === 'string') collected.set(key, 0)
        else if (isRecord(key) && typeof key.key === 'string') collected.set(key.key, 0)
      }
      if (keys.length < pageSize) break
    }
  }

  if (collected.size === 0 && !recognized) {
    throw new UpstreamError(0, 'bad_response', '云端未返回可识别的键列表')
  }

  const keys = [...collected.entries()]
    .map(([key, updatedAt]) => ({ key, updatedAt }))
    .filter(({ key }) => isValidRemoteKey(key))
    .sort((a, b) => a.key.localeCompare(b.key))

  return {
    keys,
    total: Math.max(total, keys.length),
    truncated: keys.length >= MAX_UPSTREAM_KEYS || total > keys.length,
  }
}

export function isValidRemoteKey(key: string): boolean {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 200 &&
    !key.startsWith('__') &&
    !/[\u0000-\u001f\u007f]/.test(key)
  )
}

export async function fetchUpstreamValue(
  auth: UpstreamAuth,
  key: string,
  signal?: AbortSignal,
): Promise<{ value: unknown; missing: boolean }> {
  try {
    const payload = await requestJson(auth, `/kv/${encodeURIComponent(key)}`, signal)
    assertUpstreamSuccess(payload)
    return { value: unwrapServerValue(payload), missing: false }
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) {
      return { value: null, missing: true }
    }
    throw err
  }
}

/** 部分部署把值包在 { value } 中；上游默认直接返回原始值 */
function unwrapServerValue(payload: unknown): unknown {
  if (
    isRecord(payload) &&
    'value' in payload &&
    !('homework' in payload) &&
    !('attendance' in payload) &&
    ('key' in payload || 'updatedAt' in payload || 'success' in payload)
  ) {
    return payload.value
  }
  return payload
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let done = 0
  let lastReport = 0
  const report = () => {
    const current = Date.now()
    if (done === items.length || current - lastReport > 120) {
      lastReport = current
      onProgress?.(done, items.length)
    }
  }
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw new UpstreamError(0, 'aborted', '已取消')
      const index = cursor++
      results[index] = await task(items[index], index)
      done += 1
      report()
    }
  })
  await Promise.all(workers)
  return results
}

export async function loadUpstreamValues(
  auth: UpstreamAuth,
  keys: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ValueLoadResult> {
  const values = new Map<string, unknown>()
  const errors = new Map<string, string>()
  let totalBytes = 0
  await mapWithConcurrency(
    keys,
    4,
    async (key) => {
      try {
        const result = await fetchUpstreamValue(auth, key, signal)
        if (result.missing) errors.set(key, '云端已删除该键')
        else {
          totalBytes += sizeOf(result.value)
          if (totalBytes > MAX_PREVIEW_BYTES) {
            throw new UpstreamError(
              0,
              'preview_too_large',
              '所选数据超过 80 MB，预览内存不足，请分批选择日期后导入',
            )
          }
          values.set(key, result.value)
        }
      } catch (err) {
        if (err instanceof UpstreamError && err.code === 'preview_too_large') throw err
        errors.set(key, err instanceof Error ? err.message : '读取失败')
      }
    },
    onProgress,
    signal,
  )
  return { values, errors }
}

/* ------------------------------------------------------------------ */
/* 键分类与展示                                                        */
/* ------------------------------------------------------------------ */

export function boardDateFromKey(key: string): Date | null {
  const match = /^classworks-data-(\d{8})$/.exec(key)
  if (!match) return null
  const raw = match[1]
  const year = Number(raw.slice(0, 4))
  const month = Number(raw.slice(4, 6))
  const day = Number(raw.slice(6, 8))
  const date = new Date(year, month - 1, day)
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

export function classifyKey(key: string): ImportCategory {
  if (boardDateFromKey(key)) return 'board'
  return CONFIG_DEFINITIONS[key]?.category ?? 'other'
}

export function importLabelFor(key: string): string {
  if (classifyKey(key) === 'board') {
    const date = boardDateFromKey(key)
    return date
      ? `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 作业`
      : key
  }
  return CONFIG_DEFINITIONS[key]?.label ?? key
}

export function configDescription(key: string): string {
  return CONFIG_DEFINITIONS[key]?.description ?? ''
}

export const KNOWN_CONFIG_KEYS = Object.keys(CONFIG_DEFINITIONS)

/* ------------------------------------------------------------------ */
/* 数据校验与归一化                                                    */
/* ------------------------------------------------------------------ */

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0))]
}

export function normalizeBoardValue(value: unknown): {
  value: BoardData
  warnings: string[]
} | null {
  if (!isRecord(value)) return null
  if (!isRecord(value.homework)) return null
  const warnings: string[] = []
  const homework: BoardData['homework'] = Object.create(null)
  let dropped = 0

  for (const [key, raw] of Object.entries(value.homework)) {
    if (!key || !isRecord(raw)) {
      warnings.push(`忽略无效科目 ${key}`)
      continue
    }
    const content = typeof raw.content === 'string' ? raw.content : ''
    const examId = typeof raw.examId === 'string' ? raw.examId : undefined
    const type =
      raw.type === 'custom' || raw.type === 'exam' || raw.type === 'homework'
        ? raw.type
        : undefined
    if (!content.trim() && !examId && type !== 'exam') {
      dropped += 1
      continue
    }
    homework[key] = {
      content,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(type ? { type } : {}),
      ...(examId ? { examId } : {}),
      ...(Array.isArray(raw.tags)
        ? { tags: raw.tags.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
    }
  }

  const attendanceRaw = isRecord(value.attendance) ? value.attendance : {}
  const attendance = {
    absent: stringArray(attendanceRaw.absent),
    late: stringArray(attendanceRaw.late),
    exclude: stringArray(attendanceRaw.exclude),
  }

  if (dropped > 0) warnings.push(`已忽略 ${dropped} 个空内容科目`)
  if (!Object.keys(homework).length) {
    const hasAttendance =
      attendance.absent.length + attendance.late.length + attendance.exclude.length > 0
    if (!hasAttendance) warnings.push('空白作业板（无作业与出勤）')
  }
  return { value: { homework, attendance }, warnings }
}

export function normalizeStudents(value: unknown): Student[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const students: Student[] = []
  for (const item of value) {
    const name =
      typeof item === 'string'
        ? item.trim()
        : isRecord(item) && typeof item.name === 'string'
          ? item.name.trim()
          : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    students.push({ name })
  }
  return students
}

export function normalizeSubjects(value: unknown): Subject[] | null {
  if (!Array.isArray(value)) return null
  const seen = new Set<string>()
  const subjects: Subject[] = []
  value.forEach((item, index) => {
    if (!isRecord(item) || typeof item.name !== 'string') return
    const name = item.name.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    subjects.push({ name, order: typeof item.order === 'number' ? item.order : index })
  })
  return subjects.sort((a, b) => a.order - b.order)
}

export function normalizeExams(value: unknown): ExamConfig[] | null {
  if (!Array.isArray(value)) return null
  const exams: ExamConfig[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const subjects = Array.isArray(item.subjects)
      ? item.subjects
          .filter(
            (subject): subject is Record<string, unknown> =>
              isRecord(subject) && typeof subject.name === 'string' && typeof subject.date === 'string',
          )
          .map((subject) => ({
            name: String(subject.name),
            date: String(subject.date),
            ...(typeof subject.start === 'string' ? { start: subject.start } : {}),
            ...(typeof subject.end === 'string' ? { end: subject.end } : {}),
            ...(typeof subject.room === 'string' ? { room: subject.room } : {}),
          }))
      : []
    exams.push({
      id: item.id,
      examName: typeof item.examName === 'string' ? item.examName : '未命名考试',
      ...(typeof item.note === 'string' ? { note: item.note } : {}),
      subjects,
      createdAt: asTimestamp(item.createdAt),
      updatedAt: asTimestamp(item.updatedAt),
    })
  }
  return exams
}

export function normalizeTemplate(value: unknown): HomeworkTemplate | null {
  if (!isRecord(value)) return null
  if (!isRecord(value.subjects)) return null
  return value as unknown as HomeworkTemplate
}

export function normalizeNoiseConfig(
  value: unknown,
): { sessions: { name: string; start: string; duration: number; enabled: boolean }[]; alertThresholdDb: number } | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null
  const sessions = value.sessions
    .filter(
      (session): session is Record<string, unknown> =>
        isRecord(session) && typeof session.name === 'string' && typeof session.start === 'string',
    )
    .map((session) => ({
      name: String(session.name),
      start: String(session.start),
      duration: typeof session.duration === 'number' ? session.duration : 60,
      enabled: session.enabled !== false,
    }))
  return {
    sessions,
    alertThresholdDb:
      typeof value.alertThresholdDb === 'number' ? value.alertThresholdDb : 55,
  }
}

export function unwrapUpstreamValue(value: unknown): unknown {
  return unwrapServerValue(value)
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

function mergeStudents(local: Student[] | null, remote: Student[]): { value: Student[]; notes: string[] } {
  const base = [...(local ?? [])]
  const seen = new Set(base.map((item) => item.name))
  const added: string[] = []
  for (const student of remote) {
    if (seen.has(student.name)) continue
    seen.add(student.name)
    base.push(student)
    added.push(student.name)
  }
  return {
    value: base,
    notes: added.length ? [`新增 ${added.length} 名学生`] : ['名单已包含全部学生'],
  }
}

function mergeSubjects(local: Subject[] | null, remote: Subject[]): { value: Subject[]; notes: string[] } {
  const base = [...(local ?? [])]
  const seen = new Set(base.map((item) => item.name))
  let maxOrder = base.reduce((max, item) => Math.max(max, item.order), -1)
  const added: string[] = []
  for (const subject of [...remote].sort((a, b) => a.order - b.order)) {
    if (seen.has(subject.name)) continue
    seen.add(subject.name)
    maxOrder += 1
    base.push({ name: subject.name, order: maxOrder })
    added.push(subject.name)
  }
  return {
    value: base,
    notes: added.length ? [`新增科目：${added.join('、')}`] : ['科目已完整'],
  }
}

function mergeExams(local: ExamConfig[] | null, remote: ExamConfig[]): { value: ExamConfig[]; notes: string[] } {
  const base = [...(local ?? [])]
  const seen = new Set(base.map((exam) => exam.id))
  const added: string[] = []
  for (const exam of remote) {
    if (seen.has(exam.id)) continue
    seen.add(exam.id)
    base.push(exam)
    added.push(exam.examName)
  }
  return {
    value: base,
    notes: added.length ? [`新增考试：${added.join('、')}`] : ['考试配置已完整'],
  }
}

function mergeBoards(local: BoardData, remote: BoardData): { value: BoardData; notes: string[] } {
  const homework: BoardData['homework'] = Object.assign(Object.create(null), local.homework)
  let added = 0
  let filled = 0
  for (const [key, item] of Object.entries(remote.homework)) {
    if (!homework[key]) {
      homework[key] = item
      added += 1
    } else if (!homework[key].content?.trim() && item.content?.trim()) {
      homework[key] = item
      filled += 1
    }
  }

  const localAttendance = local.attendance
  const localHasAttendance =
    localAttendance.absent.length + localAttendance.late.length + localAttendance.exclude.length > 0
  const remoteHasAttendance =
    remote.attendance.absent.length +
      remote.attendance.late.length +
      remote.attendance.exclude.length >
    0
  const attendance = !localHasAttendance && remoteHasAttendance ? remote.attendance : localAttendance

  const notes: string[] = []
  if (added) notes.push(`补充 ${added} 个科目`)
  if (filled) notes.push(`填充 ${filled} 个空科目`)
  if (!localHasAttendance && remoteHasAttendance) notes.push('补充出勤记录')
  if (!notes.length) notes.push('本地内容已覆盖云端科目')
  return { value: { homework, attendance }, notes }
}

function sizeOf(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 摘要                                                                */
/* ------------------------------------------------------------------ */

export function summarizeValue(category: ImportCategory, value: unknown): string {
  if (category === 'board') {
    const board = normalizeBoardValue(value)
    if (!board) return '无法识别作业板结构'
    const subjectCount = Object.values(board.value.homework).filter((item) =>
      item.content?.trim(),
    ).length
    const { absent, late, exclude } = board.value.attendance
    const attendance = absent.length + late.length + exclude.length
    return `${subjectCount} 个科目${attendance ? ` · 出勤异常 ${attendance} 人` : ''}`
  }
  if (category === 'students') {
    const students = normalizeStudents(value)
    return students ? `${students.length} 名学生` : '无法识别花名册'
  }
  if (category === 'subjects') {
    const subjects = normalizeSubjects(value)
    return subjects
      ? `${subjects.length} 个科目：${subjects.map((item) => item.name).join('、')}`
      : '无法识别科目配置'
  }
  if (category === 'exams') {
    const exams = normalizeExams(value)
    return exams ? `${exams.length} 场考试` : '无法识别考试配置'
  }
  if (category === 'template') {
    const template = normalizeTemplate(value)
    return template
      ? `${Object.keys(template.subjects ?? {}).length} 个科目模板`
      : '无法识别作业模板'
  }
  if (category === 'noise') {
    const config = normalizeNoiseConfig(value)
    return config
      ? `${config.sessions.length} 个时段 · 阈值 ${config.alertThresholdDb} dB`
      : '无法识别噪音时段'
  }
  return `${Array.isArray(value) ? '列表' : typeof value} · ${sizeOf(value)} B`
}

/* ------------------------------------------------------------------ */
/* 导入计划                                                            */
/* ------------------------------------------------------------------ */

export interface BuildPlanOptions {
  strategy: ConflictStrategy
  skipEmptyBoards?: boolean
  localKeys: Map<string, number>
  localRecords?: Map<string, LocalRecord>
}

export function buildImportPlan(
  selections: ImportSelection[],
  remoteValues: Map<string, unknown>,
  remoteErrors: Map<string, string>,
  options: BuildPlanOptions,
): ImportPlan {
  const rows: ImportPlanRow[] = []
  const counts: Record<PlanAction, number> = { new: 0, overwrite: 0, merge: 0, skip: 0, error: 0 }
  let totalBytes = 0
  let warningCount = 0

  for (const selection of selections) {
    const { key, category, remoteUpdatedAt } = selection
    const localExists = options.localKeys.has(key)
    const localUpdatedAt = options.localKeys.get(key)
    const warnings: string[] = []
    const label = importLabelFor(key)
    const push = (row: ImportPlanRow) => {
      counts[row.action] += 1
      warningCount += row.warnings.length
      if (row.action !== 'skip' && row.action !== 'error' && row.value !== undefined) {
        totalBytes += row.size
      }
      rows.push(row)
    }

    const remoteError = remoteErrors.get(key)
    if (remoteError) {
      push({
        key,
        category,
        label,
        action: 'error',
        localExists,
        localUpdatedAt,
        remoteUpdatedAt,
        size: 0,
        summary: '读取失败',
        warnings,
        reason: remoteError,
      })
      continue
    }
    if (!remoteValues.has(key)) {
      push({
        key,
        category,
        label,
        action: 'error',
        localExists,
        localUpdatedAt,
        remoteUpdatedAt,
        size: 0,
        summary: '云端未返回数据',
        warnings,
        reason: '该键在云端不存在或已被删除',
      })
      continue
    }

    const rawRemote = remoteValues.get(key)
    let normalized: unknown = rawRemote
    if (category === 'board') {
      const board = normalizeBoardValue(rawRemote)
      if (!board) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '作业板结构无效',
          warnings,
          reason: '缺少 homework / attendance 字段',
        })
        continue
      }
      warnings.push(...board.warnings)
      normalized = board.value
      if (
        options.skipEmptyBoards &&
        Object.keys(board.value.homework).length === 0 &&
        board.value.attendance.absent.length +
          board.value.attendance.late.length +
          board.value.attendance.exclude.length ===
          0
      ) {
        push({
          key,
          category,
          label,
          action: 'skip',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '空白作业板',
          warnings,
          reason: '已按设置跳过空白作业板',
        })
        continue
      }
    } else if (category === 'students') {
      const students = normalizeStudents(rawRemote)
      if (!students) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '花名册结构无效',
          warnings,
          reason: '云端值不是数组',
        })
        continue
      }
      normalized = students
    } else if (category === 'subjects') {
      const subjects = normalizeSubjects(rawRemote)
      if (!subjects) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '科目结构无效',
          warnings,
          reason: '云端值不是数组',
        })
        continue
      }
      normalized = subjects
    } else if (category === 'exams') {
      const exams = normalizeExams(rawRemote)
      if (!exams) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '考试配置结构无效',
          warnings,
          reason: '云端值不是数组',
        })
        continue
      }
      normalized = exams
    } else if (category === 'template') {
      const template = normalizeTemplate(rawRemote)
      if (!template) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '作业模板结构无效',
          warnings,
          reason: '缺少 subjects 字段',
        })
        continue
      }
      normalized = template
    } else if (category === 'noise') {
      const config = normalizeNoiseConfig(rawRemote)
      if (!config) {
        push({
          key,
          category,
          label,
          action: 'error',
          localExists,
          localUpdatedAt,
          remoteUpdatedAt,
          size: 0,
          summary: '噪音配置结构无效',
          warnings,
          reason: '缺少 sessions 字段',
        })
        continue
      }
      normalized = config
    }

    let action: PlanAction = localExists ? 'overwrite' : 'new'
    let value = normalized
    let reason: string | undefined

    if (localExists && options.strategy === 'skip') {
      action = 'skip'
      reason = '本地已存在该键，按策略保留本地'
      value = undefined
    } else if (localExists && options.strategy === 'merge') {
      const local = options.localRecords?.get(key)
      if (!local) {
        action = 'skip'
        reason = '未能读取本地数据，已跳过合并'
        value = undefined
      } else if (category === 'board') {
        const localBoard = normalizeBoardValue(local.value)
        const remoteBoard = normalized as BoardData
        if (!localBoard) {
          action = 'overwrite'
          reason = '本地作业板结构异常，使用云端数据'
        } else {
          const merged = mergeBoards(localBoard.value, remoteBoard)
          if (sameJson(merged.value, localBoard.value)) {
            action = 'skip'
            reason = '合并后与本地一致'
            value = undefined
          } else {
            action = 'merge'
            value = merged.value
            reason = merged.notes.join('；')
          }
        }
      } else if (category === 'students') {
        const localStudents = normalizeStudents(local.value) ?? []
        const merged = mergeStudents(localStudents, normalized as Student[])
        if (sameJson(merged.value, localStudents)) {
          action = 'skip'
          reason = '花名册已包含云端学生'
          value = undefined
        } else {
          action = 'merge'
          value = merged.value
          reason = merged.notes.join('；')
        }
      } else if (category === 'subjects') {
        const localSubjects = normalizeSubjects(local.value) ?? []
        const merged = mergeSubjects(localSubjects, normalized as Subject[])
        if (sameJson(merged.value, localSubjects)) {
          action = 'skip'
          reason = '科目已完整'
          value = undefined
        } else {
          action = 'merge'
          value = merged.value
          reason = merged.notes.join('；')
        }
      } else if (category === 'exams') {
        const localExams = normalizeExams(local.value) ?? []
        const merged = mergeExams(localExams, normalized as ExamConfig[])
        if (sameJson(merged.value, localExams)) {
          action = 'skip'
          reason = '考试配置已完整'
          value = undefined
        } else {
          action = 'merge'
          value = merged.value
          reason = merged.notes.join('；')
        }
      } else {
        action = 'skip'
        reason = '该数据类型不支持合并，按策略保留本地'
        value = undefined
      }
    }

    if (localExists && action === 'overwrite' && sameJson(normalized, options.localRecords?.get(key)?.value)) {
      action = 'skip'
      reason = '与本地内容一致，无需写入'
      value = undefined
    }

    const finalValue = action === 'skip' ? undefined : value
    // 与服务器落盘口径一致：{"v": value, "t": 时间戳}
    const size = finalValue === undefined ? 0 : sizeOf({ v: finalValue, t: 1_700_000_000_000 })
    if (finalValue !== undefined && size > 1_000_000) {
      warnings.push('单条记录超过 1 MB，导入时会被拒绝')
    }

    push({
      key,
      category,
      label,
      action,
      localExists,
      localUpdatedAt,
      remoteUpdatedAt,
      size,
      summary: summarizeValue(category, finalValue ?? normalized),
      warnings,
      reason,
      value: finalValue,
    })
  }

  const records = rows
    .filter(
      (row) =>
        (row.action === 'new' || row.action === 'overwrite' || row.action === 'merge') &&
        row.value !== undefined &&
        !row.warnings.some((warning) => warning.includes('超过 1 MB')),
    )
    .map((row) => ({
      key: row.key,
      value: row.value,
      expectedUpdatedAt: row.localExists ? (row.localUpdatedAt ?? null) : null,
    }))

  return { rows, counts, totalBytes, warningCount, records }
}

/* ------------------------------------------------------------------ */
/* 分块执行                                                            */
/* ------------------------------------------------------------------ */

export function chunkImportRecords(
  records: ImportRecord[],
  maxCount = 50,
  maxBytes = 700_000,
): ImportRecord[][] {
  const chunks: ImportRecord[][] = []
  let current: ImportRecord[] = []
  let currentBytes = 0

  for (const record of records) {
    const bytes = sizeOf(record.value) + record.key.length + 64
    if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(record)
    currentBytes += bytes
  }
  if (current.length) chunks.push(current)
  return chunks
}

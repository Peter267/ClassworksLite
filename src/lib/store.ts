/**
 * 应用数据中心。
 *
 * 采用「外部可变 store + useSyncExternalStore」的模式：
 * 全局只有一份状态，卡片、工具栏、对话框共享，避免层层透传 props。
 */

import { ACCESS_STATUS_EVENT, isEditLocked } from './access'
import { DEFAULT_STUDENTS, DEFAULT_SUBJECTS } from './defaults'
import { isSameDay, toDateKey, today } from './date'
import {
  broadcastChange,
  ConflictError,
  getClient,
  refreshClient,
  SaveError,
  syncChannel,
} from './kv'
import { getSetting } from './settings'
import { toast } from './toast'
import type { Attendance, BoardData, ExamConfig, HomeworkItem, KVEntry, Subject } from './types'

export const KEYS = {
  board: (dateKey: string) => `classworks-data-${dateKey}`,
  students: 'classworks-list-main',
  subjects: 'classworks-config-subject',
  template: 'classworks-config-homework-template',
  exams: 'classworks-exams',
}

export type AttendanceKind = keyof Attendance

type KeyList = {
  keys: { key: string; updatedAt: number }[]
  truncated: boolean
  stale?: boolean
}

export interface AppState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  dateKey: string
  date: Date
  board: BoardData
  students: string[]
  subjects: Subject[]
  exams: ExamConfig[]
  dirty: boolean
  saving: boolean
  queued: boolean
  updatedAt: number | null
  pendingSync: number
  offline: boolean
  source: 'local' | 'cloud'
  /** 当前作业板是否成功从数据源读取；读取失败时禁止覆盖写入 */
  loaded: boolean
  /** 花名册/科目/考试是否成功读取；未成功时禁止用默认值覆盖云端 */
  catalogLoaded: boolean
  /** 最近一次远程刷新时间，用于顶部状态提示 */
  lastRefresh: number | null
}

function emptyBoard(): BoardData {
  return { homework: {}, attendance: { absent: [], late: [], exclude: [] } }
}

function normalizeBoard(input: unknown): BoardData {
  const raw = (input ?? {}) as Partial<BoardData>
  const attendance = (raw.attendance ?? {}) as Partial<Attendance>
  const homework: Record<string, HomeworkItem> = {}
  for (const [key, value] of Object.entries(raw.homework ?? {})) {
    if (!value || typeof value !== 'object') continue
    const item = value as HomeworkItem
    homework[key] = {
      content: typeof item.content === 'string' ? item.content : '',
      name: item.name,
      type: item.type,
      examId: item.examId,
      tags: Array.isArray(item.tags) ? item.tags : undefined,
    }
  }
  return {
    homework,
    attendance: {
      absent: Array.isArray(attendance.absent) ? attendance.absent : [],
      late: Array.isArray(attendance.late) ? attendance.late : [],
      exclude: Array.isArray(attendance.exclude) ? attendance.exclude : [],
    },
  }
}

class BoardStore {
  private listeners = new Set<() => void>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** 读取序号：切换日期时丢弃过期响应，避免旧日期数据落到新日期（D2） */
  private loadSeq = 0
  private initialized = false
  private channelBound = false
  private settingsBound = false
  private accessBound = false
  private settingsTimer: ReturnType<typeof setTimeout> | null = null
  private readOnlyNoticeAt = 0
  private lastCatalogPoll = 0
  /** 最近一次成功读取/写入各目录键的版本，用于条件写而不是临时 GET */
  private catalogUpdatedAt: Record<string, number | null> = {}
  /** 目录写串行化：同一键的快速连续增删不能拿同一个旧版本并发提交 */
  private catalogWriteChain: Promise<unknown> = Promise.resolve()

  state: AppState = {
    status: 'loading',
    error: null,
    dateKey: toDateKey(today()),
    date: today(),
    board: emptyBoard(),
    students: DEFAULT_STUDENTS,
    subjects: DEFAULT_SUBJECTS,
    exams: [],
    dirty: false,
    saving: false,
    queued: false,
    updatedAt: null,
    pendingSync: 0,
    offline: false,
    source: 'local',
    loaded: false,
    catalogLoaded: false,
    lastRefresh: null,
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getSnapshot = () => this.state

  private patch(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial }
    this.listeners.forEach((fn) => fn())
  }

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  async init() {
    if (this.initialized) return
    this.initialized = true

    const mode = refreshClient()
    this.patch({ source: mode })

    const urlDate = this.readDateFromUrl()
    const initialDate = urlDate ?? today()
    this.patch({ date: initialDate, dateKey: toDateKey(initialDate) })

    await Promise.all([this.loadCatalog(), this.loadBoard()])

    // 上次离线留下的待同步队列必须在启动时补传，不能只依赖 online 事件
    if (getSetting<string>('server.provider') === 'cloud') {
      try {
        const pending = await getClient().pendingCount()
        if (pending > 0) {
          const flushed = await getClient().flush()
          this.patch({ pendingSync: await getClient().pendingCount() })
          if (flushed > 0) {
            toast.success('已补传离线改动', `${flushed} 条数据已同步`)
            if (!this.state.dirty) {
              await this.loadBoard(true)
              await this.loadCatalog()
            }
          }
        }
      } catch (err) {
        console.warn('[store] 启动补传失败', err)
      }
    }

    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')) {
      // 演示数据必须在对外宣布 ready 之前写完，否则 ?edit= 深链会读到空数据
      this.patch({ status: 'loading' })
      await this.seedDemo()
      this.patch({ status: 'ready' })
    }

    this.startPolling()
    this.bindChannel()
    this.bindSettings()
    this.bindAccess()

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
      window.addEventListener('classworks-lite:sync-error', this.handleSyncError)
      document.addEventListener('visibilitychange', this.handleVisibility)
    }
  }

  private readDateFromUrl(): Date | null {
    if (typeof window === 'undefined') return null
    const raw = new URLSearchParams(window.location.search).get('date')
    if (!raw) return null
    const compact = raw.replace(/-/g, '')
    if (!/^\d{8}$/.test(compact)) return null
    const d = new Date(
      Number(compact.slice(0, 4)),
      Number(compact.slice(4, 6)) - 1,
      Number(compact.slice(6, 8)),
    )
    return Number.isNaN(d.getTime()) ? null : d
  }

  /* ---------------------------------------------------------------- */
  /* 读取                                                              */
  /* ---------------------------------------------------------------- */

  private async loadCatalog(): Promise<boolean> {
    const client = getClient()
    const [studentResult, subjectResult, examResult] = await Promise.allSettled([
      client.get<{ name: string }[] | string[]>(KEYS.students),
      client.get<Subject[]>(KEYS.subjects),
      client.get<ExamConfig[]>(KEYS.exams),
    ])

    const patch: Partial<AppState> = {}
    const versions: Record<string, number | null> = {}
    let complete = true

    if (studentResult.status === 'fulfilled') {
      const studentEntry = studentResult.value
      versions[KEYS.students] = studentEntry?.updatedAt ?? null
      const students = Array.isArray(studentEntry?.value)
        ? studentEntry.value
            .map((item) => (typeof item === 'string' ? item : item?.name))
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
        : null
      patch.students = students && students.length > 0 ? students : DEFAULT_STUDENTS
    } else {
      complete = false
      console.warn('[store] 学生名单加载失败', studentResult.reason)
    }

    if (subjectResult.status === 'fulfilled') {
      const subjectEntry = subjectResult.value
      versions[KEYS.subjects] = subjectEntry?.updatedAt ?? null
      const subjects =
        Array.isArray(subjectEntry?.value) && subjectEntry.value.length > 0
          ? subjectEntry.value
              .filter((item) => item && typeof item.name === 'string')
              .map((item, index) => ({ name: item.name, order: item.order ?? index }))
              .sort((a, b) => a.order - b.order)
          : null
      patch.subjects = subjects ?? DEFAULT_SUBJECTS
    } else {
      complete = false
      console.warn('[store] 科目加载失败', subjectResult.reason)
    }

    if (examResult.status === 'fulfilled') {
      versions[KEYS.exams] = examResult.value?.updatedAt ?? null
      patch.exams = Array.isArray(examResult.value?.value) ? examResult.value.value : []
    } else {
      complete = false
      console.warn('[store] 考试配置加载失败', examResult.reason)
    }

    try {
      patch.pendingSync = await client.pendingCount()
    } catch {
      /* 统计失败不影响配置读取 */
    }
    patch.catalogLoaded = complete || this.state.catalogLoaded
    this.catalogUpdatedAt = { ...this.catalogUpdatedAt, ...versions }
    this.patch(patch)
    return complete
  }

  async loadBoard(force = false): Promise<boolean> {
    const client = getClient()
    const key = KEYS.board(this.state.dateKey)
    const dateKey = this.state.dateKey
    const seq = (this.loadSeq += 1)
    this.patch({ status: this.state.status === 'ready' && !force ? 'ready' : 'loading' })

    try {
      const entry = await client.get<BoardData>(key)
      // 期间又切换了日期 / 发起了更新的读取：丢弃本次结果
      if (seq !== this.loadSeq || dateKey !== this.state.dateKey) return false
      // 读取期间用户开始编辑：保留本地改动，不能用远程快照覆盖
      if (this.state.dirty || this.state.saving) {
        this.patch({ status: 'ready' })
        return false
      }
      this.patch({
        board: entry ? normalizeBoard(entry.value) : emptyBoard(),
        updatedAt: entry?.updatedAt ?? null,
        status: 'ready',
        error: null,
        dirty: false,
        loaded: true,
        queued: Boolean(entry?.pending),
        offline: Boolean(entry?.stale),
        lastRefresh: Date.now(),
      })
      return true
    } catch (err) {
      if (seq !== this.loadSeq || dateKey !== this.state.dateKey) return false
      const message = err instanceof Error ? err.message : '数据加载失败'
      this.patch({ status: 'error', error: message, loaded: false })
      return false
    }
  }

  async refresh() {
    if (this.state.dirty) {
      toast.warning('有未保存的改动', '请先上传或撤销，再刷新数据')
      return
    }
    const before = this.state.updatedAt
    const [boardOk, catalogOk] = await Promise.all([this.loadBoard(true), this.loadCatalog()])
    if (!boardOk) {
      if (this.state.dirty) {
        toast.warning('已保留当前编辑', '刷新期间产生了新的改动，未应用线上数据')
      } else {
        toast.error('刷新失败', this.state.error ?? '无法读取当前作业板')
      }
      return
    }
    if (!catalogOk) {
      toast.warning('部分配置未刷新', '学生名单/科目/考试配置读取失败，可稍后重试')
    }
    if (this.state.updatedAt !== before) {
      toast.info('已刷新', '数据已更新到最新')
    } else {
      toast.success('已刷新', '当前已是最新数据')
    }
  }

  /* ---------------------------------------------------------------- */
  /* 日期                                                              */
  /* ---------------------------------------------------------------- */

  async goToDate(date: Date): Promise<boolean> {
    if (isSameDay(date, this.state.date)) return true
    // 切换日期前先落盘；落盘失败或用户取消时不得继续，否则改动会被空板覆盖（D4）
    if (this.state.dirty) {
      const ok = await this.save({ silent: true, auto: this.canAutoSave() })
      if (!ok) {
        if (this.state.dirty) toast.warning('未切换日期', '当前改动尚未保存，请先上传或撤销')
        return false
      }
    }
    this.patch({
      date,
      dateKey: toDateKey(date),
      board: emptyBoard(),
      dirty: false,
      loaded: false,
      updatedAt: null,
      status: 'loading',
    })
    // 日期已经切换；即使读取失败也返回 true，让调用方同步 URL，页面会自行展示错误状态
    await this.loadBoard(true)
    return true
  }

  /* ---------------------------------------------------------------- */
  /* 作业编辑                                                          */
  /* ---------------------------------------------------------------- */

  private ensureEditable(): boolean {
    if (!isEditLocked()) return true
    const now = Date.now()
    if (now - this.readOnlyNoticeAt > 3000) {
      this.readOnlyNoticeAt = now
      toast.warning('只读模式', '请在 设置 → 服务器 → 访问权限 中填写编辑令牌')
    }
    return false
  }

  private commitBoard(next: BoardData): boolean {
    if (!this.state.loaded) {
      toast.error('数据尚未加载完成', '请刷新并成功加载后再编辑')
      return false
    }
    if (!this.ensureEditable()) return false
    this.patch({ board: next, dirty: true })
    this.scheduleSave()
    return true
  }

  setHomework(subject: string, content: string): boolean {
    const homework = { ...this.state.board.homework }
    const existing = homework[subject]
    const trimmed = content.trim()
    if (!trimmed) {
      // 清空即删除；考试卡片保留（由考试看板管理）
      if (existing?.type === 'exam') return false
      delete homework[subject]
    } else {
      homework[subject] = { ...(existing ?? {}), content: trimmed }
    }
    return this.commitBoard({ ...this.state.board, homework })
  }

  removeHomework(subject: string): boolean {
    const homework = { ...this.state.board.homework }
    delete homework[subject]
    return this.commitBoard({ ...this.state.board, homework })
  }

  addCustomCard(name = '自定义卡片', content = ''): string | null {
    const key = `custom-${Date.now()}`
    const homework = {
      ...this.state.board.homework,
      [key]: { name, content, type: 'custom' as const },
    }
    return this.commitBoard({ ...this.state.board, homework }) ? key : null
  }

  renameCustomCard(key: string, name: string): boolean {
    const item = this.state.board.homework[key]
    if (!item) return false
    return this.commitBoard({
      ...this.state.board,
      homework: { ...this.state.board.homework, [key]: { ...item, name } },
    })
  }

  addExamCard(examId: string): { ok: boolean; added: boolean } {
    const key = `exam-${examId}`
    const homework = { ...this.state.board.homework }
    const adding = !homework[key]
    if (adding) homework[key] = { type: 'exam', examId, name: '考试安排', content: '' }
    else delete homework[key]
    const ok = this.commitBoard({ ...this.state.board, homework })
    return { ok, added: ok && adding }
  }

  /* ---------------------------------------------------------------- */
  /* 跨日期操作                                                        */
  /* ---------------------------------------------------------------- */

  /** 把当前日期的作业复制到今天（只补空缺，不覆盖已有内容） */
  async copyToToday(): Promise<number> {
    if (!this.ensureEditable()) return 0
    // 与 goToDate 一致：先保存当前日期的未保存改动，失败则不得切换
    if (this.state.dirty) {
      const ok = await this.save({ silent: true, auto: this.canAutoSave() })
      if (!ok && this.state.dirty) {
        toast.warning('未复制', '当前改动尚未保存，请先上传或撤销')
        return 0
      }
    }
    const targetDate = today()
    const targetKey = toDateKey(targetDate)
    if (targetKey === this.state.dateKey) return 0

    const client = getClient()
    let entry: KVEntry<BoardData> | null = null
    try {
      entry = await client.get<BoardData>(KEYS.board(targetKey))
    } catch (err) {
      toast.error('无法读取今天的作业板', err instanceof Error ? err.message : '请检查网络')
      return 0
    }
    const target = entry ? normalizeBoard(entry.value) : emptyBoard()

    let count = 0
    for (const [key, item] of Object.entries(this.state.board.homework)) {
      if (!item.content?.trim()) continue
      if (target.homework[key]?.content?.trim()) continue
      target.homework[key] = { ...item }
      count += 1
    }
    if (count === 0) return 0

    try {
      const { entry: saved, queued } = await client.set(KEYS.board(targetKey), target, {
        baseUpdatedAt: entry?.updatedAt ?? null,
      })
      broadcastChange(KEYS.board(targetKey))
      this.patch({
        date: targetDate,
        dateKey: targetKey,
        board: target,
        dirty: false,
        loaded: true,
        queued,
        offline: queued,
        updatedAt: queued ? entry?.updatedAt ?? null : saved.updatedAt,
        status: 'ready',
      })
      return count
    } catch (err) {
      if (err instanceof ConflictError) {
        toast.warning('今天的作业板已被其他设备修改', '请先刷新今天的作业板再重试')
      } else {
        toast.error('复制失败', err instanceof Error ? err.message : '请检查网络')
      }
      return 0
    }
  }

  /* ---------------------------------------------------------------- */
  /* 出勤                                                              */
  /* ---------------------------------------------------------------- */

  setAttendance(kind: AttendanceKind, names: string[]): boolean {
    // 批量登记同样要保证「一人一种状态」，否则统计会重复扣减（F2）
    const unique = Array.from(new Set(names))
    const next: Attendance = { ...this.state.board.attendance, [kind]: unique }
    for (const other of ['absent', 'late', 'exclude'] as AttendanceKind[]) {
      if (other === kind) continue
      next[other] = next[other].filter((name) => !unique.includes(name))
    }
    return this.commitBoard({ ...this.state.board, attendance: next })
  }

  toggleAttendance(name: string, kind: AttendanceKind): boolean {
    const current = this.state.board.attendance
    const others: AttendanceKind[] = ['absent', 'late', 'exclude']
    const next: Attendance = { ...current }
    const list = next[kind]
    next[kind] = list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
    // 学生只能属于一种状态
    if (!list.includes(name)) {
      for (const other of others) {
        if (other !== kind) next[other] = next[other].filter((n) => n !== name)
      }
    }
    return this.commitBoard({ ...this.state.board, attendance: next })
  }

  clearAttendance(): boolean {
    return this.commitBoard({
      ...this.state.board,
      attendance: { absent: [], late: [], exclude: [] },
    })
  }

  /* ---------------------------------------------------------------- */
  /* 保存                                                              */
  /* ---------------------------------------------------------------- */

  private scheduleSave() {
    if (!getSetting<boolean>('edit.autoSave')) return
    if (!this.canAutoSave()) return
    // 历史日期要求人工确认时不做后台自动保存，避免反复弹确认框
    if (!isSameDay(this.state.date, today()) && getSetting<boolean>('edit.confirmNonTodaySave')) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.save({ silent: true, auto: true })
    }, 2000)
  }

  canAutoSave(): boolean {
    const isToday = isSameDay(this.state.date, today())
    if (isToday) return true
    return !getSetting<boolean>('edit.blockNonTodayAutoSave')
  }

  flushPendingSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  async save(opts: { silent?: boolean; auto?: boolean } = {}): Promise<boolean> {
    this.flushPendingSave()
    if (this.state.saving) return false
    if (!this.state.dirty) {
      if (!opts.silent) toast.info('无需保存', '当前没有改动')
      return true
    }
    if (!this.state.loaded) {
      toast.error('数据尚未加载完成', '为避免覆盖云端数据，请刷新并成功加载后再保存')
      return false
    }
    if (!this.ensureEditable()) return false

    // 历史数据保存确认统一在这里做，所有入口（首页上传/出勤完成/列表保存/设置立即上传）都不会绕过（F5）
    if (
      !opts.auto &&
      !isSameDay(this.state.date, today()) &&
      getSetting<boolean>('edit.confirmNonTodaySave') &&
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function'
    ) {
      const ok = window.confirm(`您正在修改 ${this.state.dateKey} 的数据，确定要保存吗？`)
      if (!ok) return false
    }

    const key = KEYS.board(this.state.dateKey)
    const snapshot = this.state.board
    this.patch({ saving: true })
    try {
      // 冲突时用服务端返回的最新版本作为新基线重试一次（本地优先，避免永久 409 死锁）
      const stored = await (async () => {
        let base = this.state.updatedAt
        for (let attempt = 0; ; attempt += 1) {
          try {
            const result = await getClient().set(key, snapshot, { baseUpdatedAt: base })
            return { ...result, base }
          } catch (err) {
            if (err instanceof ConflictError && attempt === 0) {
              if (typeof err.updatedAt === 'number') {
                base = err.updatedAt
                this.patch({ updatedAt: base })
                toast.warning('检测到其他设备修改', '正在用当前内容覆盖云端版本')
                continue
              }
              if (base !== null) {
                // 期望存在但服务端已删除：按新建重试
                base = null
                this.patch({ updatedAt: null })
                toast.warning('云端记录已删除', '正在用当前内容重新创建')
                continue
              }
            }
            throw err
          }
        }
      })()
      const { entry, queued, base: writtenBase } = stored
      // 保存期间又有新的编辑：保持 dirty，稍后继续保存（D3）
      const changedWhileSaving = this.state.board !== snapshot
      this.patch({
        saving: false,
        dirty: changedWhileSaving,
        queued,
        // 离线队列保留服务端基线，避免下一次保存把本地时间戳当成版本
        updatedAt: queued ? writtenBase : entry.updatedAt,
        offline: queued,
        pendingSync: await getClient().pendingCount(),
      })
      if (changedWhileSaving) this.scheduleSave()
      broadcastChange(key)
      if (queued) {
        toast.warning('已保存到本机', '网络恢复后会自动同步到云端')
      } else if (!opts.silent) {
        toast.success('保存成功', '已同步作业数据')
      }
      return true
    } catch (err) {
      this.patch({ saving: false })
      if (err instanceof ConflictError) {
        toast.warning('保存冲突', '数据已被其他设备修改，已保留本机改动；请刷新后再处理')
      } else if (err instanceof SaveError) {
        toast.error('保存被拒绝', err.message)
      } else {
        toast.error('保存失败', err instanceof Error ? err.message : '请检查同步配置')
      }
      return false
    }
  }

  /* ---------------------------------------------------------------- */
  /* 学生 / 科目 / 考试                                                 */
  /* ---------------------------------------------------------------- */

  private catalogWritable(): boolean {
    if (getSetting<string>('server.provider') === 'cloud' && !this.state.catalogLoaded) {
      toast.error('名单/科目尚未加载完成', '为避免覆盖云端数据，请刷新并成功加载后再修改')
      return false
    }
    return true
  }

  private enqueueCatalogWrite<T>(task: () => Promise<T>): Promise<T> {
    const next = this.catalogWriteChain.then(task, task)
    this.catalogWriteChain = next.catch(() => undefined)
    return next
  }

  private writeCatalog<T>(
    key: string,
    value: T,
  ): Promise<{ queued: boolean; updatedAt: number } | null> {
    return this.enqueueCatalogWrite(async () => {
      try {
        const client = getClient()
        const { entry, queued } = await client.set(key, value, {
          baseUpdatedAt: this.catalogUpdatedAt[key] ?? null,
        })
        if (!queued) this.catalogUpdatedAt[key] = entry.updatedAt
        return { queued, updatedAt: entry.updatedAt }
      } catch (err) {
        if (err instanceof ConflictError) {
          toast.warning('保存冲突', '数据已被其他设备修改，请刷新后重试')
        } else if (err instanceof SaveError) {
          toast.error('保存被拒绝', err.message)
        } else {
          toast.error('保存失败', err instanceof Error ? err.message : '请检查网络')
        }
        return null
      }
    })
  }

  async setStudents(names: string[]): Promise<boolean> {
    if (!this.ensureEditable() || !this.catalogWritable()) return false
    const clean = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)))
    const previous = this.state.students
    // 先同步更新内存，保证快速连续增删都基于最新名单；写入失败再回滚
    this.patch({ students: clean })
    const saved = await this.writeCatalog(
      KEYS.students,
      clean.map((name) => ({ name })),
    )
    if (!saved) {
      // 只有当前状态仍是这次写入的值时才回滚，避免覆盖后续快速操作
      if (this.state.students === clean) this.patch({ students: previous })
      return false
    }
    broadcastChange(KEYS.students)

    // 删除学生后同步清理当前看板的出勤名单，避免统计出现“幽灵学生”
    const valid = new Set(clean)
    const attendance = this.state.board.attendance
    const nextAttendance: Attendance = {
      absent: attendance.absent.filter((name) => valid.has(name)),
      late: attendance.late.filter((name) => valid.has(name)),
      exclude: attendance.exclude.filter((name) => valid.has(name)),
    }
    if (
      nextAttendance.absent.length !== attendance.absent.length ||
      nextAttendance.late.length !== attendance.late.length ||
      nextAttendance.exclude.length !== attendance.exclude.length
    ) {
      this.commitBoard({ ...this.state.board, attendance: nextAttendance })
    }

    try {
      this.patch({ pendingSync: await getClient().pendingCount() })
    } catch {
      /* ignore */
    }
    if (saved.queued) toast.warning('已保存到本机', '学生名单将在联网后同步')
    return true
  }

  addStudents(names: string[]): Promise<boolean> {
    return this.setStudents([...this.state.students, ...names])
  }

  removeStudent(name: string): Promise<boolean> {
    return this.setStudents(this.state.students.filter((item) => item !== name))
  }

  async setSubjects(
    subjects: Subject[],
    options: { renames?: { from: string; to: string }[] } = {},
  ): Promise<{ saved: boolean; renamed: number; queued: boolean }> {
    if (!this.ensureEditable() || !this.catalogWritable()) {
      return { saved: false, renamed: 0, queued: false }
    }
    const clean = subjects
      .map((s, index) => ({ name: s.name.trim(), order: index }))
      .filter((s) => s.name.length > 0)
    const renames = (options.renames ?? []).filter(
      (item) => item.from && item.to && item.from !== item.to,
    )

    const saved = await this.writeCatalog(KEYS.subjects, clean)
    if (!saved) return { saved: false, renamed: 0, queued: false }

    this.patch({ subjects: clean })
    broadcastChange(KEYS.subjects)
    if (saved.queued) toast.warning('已保存到本机', '科目表将在联网后同步')

    // 改名后迁移历史作业键，否则旧作业会留在孤立键里（D7）
    let renamed = 0
    for (const item of renames) renamed += await this.renameSubject(item.from, item.to)
    return { saved: true, renamed, queued: saved.queued }
  }

  /**
   * 科目改名：把各日期作业板里的旧键迁移到新键，避免旧作业变成看不见的孤立数据（D7）。
   * 返回实际迁移的日期数量。
   */
  async renameSubject(from: string, to: string): Promise<number> {
    if (!this.ensureEditable()) return 0
    const target = to.trim()
    if (!from || !target || target === from) return 0
    const client = getClient()
    const currentKey = KEYS.board(this.state.dateKey)

    let listed: KeyList
    try {
      listed = await client.list(KEYS.board(''))
    } catch (err) {
      toast.warning('历史作业迁移中止', err instanceof Error ? err.message : '无法读取历史日期列表')
      return 0
    }
    if (listed.truncated) {
      toast.warning('历史作业迁移中止', '历史数据键过多，无法安全完成全量迁移')
      return 0
    }
    if (listed.stale) {
      toast.warning('正在使用本机数据迁移', '联网后请再次执行改名以补齐未缓存的历史日期')
    }

    // 当前日期先改内存，界面立即正确
    const currentHomework = this.state.board.homework
    if (currentHomework[from]) {
      const homework = { ...currentHomework }
      homework[target] = { ...homework[from] }
      delete homework[from]
      this.commitBoard({ ...this.state.board, homework })
    }

    let migrated = 0
    try {
      for (const { key } of listed.keys) {
        if (key === currentKey) continue
        const entry = await client.get<BoardData>(key)
        if (!entry) continue
        const board = normalizeBoard(entry.value)
        if (!board.homework[from]) continue
        board.homework[target] = { ...board.homework[from] }
        delete board.homework[from]
        await client.set(key, board, { baseUpdatedAt: entry.updatedAt })
        migrated += 1
      }
    } catch (err) {
      console.warn('[store] 科目改名迁移中断', err)
      toast.warning('历史作业迁移未完成', '部分日期的作业可能仍需手动处理')
    }
    if (migrated > 0) toast.success('已迁移历史作业', `${migrated} 个日期`)
    return migrated
  }

  async saveExam(exam: ExamConfig): Promise<boolean> {
    if (!this.ensureEditable() || !this.catalogWritable()) return false
    const exists = this.state.exams.some((item) => item.id === exam.id)
    const next = exists
      ? this.state.exams.map((item) => (item.id === exam.id ? exam : item))
      : [...this.state.exams, exam]
    const saved = await this.writeCatalog(KEYS.exams, next)
    if (!saved) return false
    this.patch({ exams: next })
    broadcastChange(KEYS.exams)
    toast.success('已保存', exam.examName)
    return true
  }

  async deleteExam(id: string): Promise<boolean> {
    if (!this.ensureEditable() || !this.catalogWritable()) return false
    if (!this.state.loaded) {
      toast.error('作业板尚未加载完成', '请刷新后再删除考试，避免留下孤立卡片')
      return false
    }
    if (this.state.dirty || this.state.saving) {
      toast.warning('请先保存当前改动', '删除考试会修改所有日期的作业板，避免覆盖未保存内容')
      return false
    }
    const client = getClient()
    let listed: KeyList
    try {
      listed = await client.list(KEYS.board(''))
    } catch (err) {
      toast.error('无法读取作业板', err instanceof Error ? err.message : '未删除考试')
      return false
    }
    if (listed.truncated || listed.stale) {
      toast.warning(
        '未删除考试',
        listed.stale
          ? '离线状态无法确认所有日期的考试卡片，请联网后重试'
          : '数据键过多，无法安全清理所有日期的考试卡片',
      )
      return false
    }

    // 先删除考试配置；即便后续卡片清理失败，也只会留下可点击移除的孤儿卡片
    const next = this.state.exams.filter((item) => item.id !== id)
    const saved = await this.writeCatalog(KEYS.exams, next)
    if (!saved) return false
    this.patch({ exams: next })
    broadcastChange(KEYS.exams)

    // 再清理所有日期的看板卡片
    const cardKey = `exam-${id}`
    const currentKey = KEYS.board(this.state.dateKey)
    let currentSavedAt: number | null = null
    let currentQueued = false
    let cleanupFailed = false
    for (const { key } of listed.keys) {
      try {
        const entry = await client.get<BoardData>(key)
        if (!entry) continue
        const board = normalizeBoard(entry.value)
        if (!board.homework[cardKey]) continue
        delete board.homework[cardKey]
        const { entry: written, queued } = await client.set(key, board, {
          baseUpdatedAt: entry.updatedAt,
        })
        if (key === currentKey) {
          currentSavedAt = written.updatedAt
          currentQueued = queued
        }
      } catch (err) {
        cleanupFailed = true
        toast.warning(
          '考试已删除，但部分卡片未清理',
          err instanceof Error ? err.message : '请回到对应日期手动移除卡片',
        )
        break
      }
    }

    if (currentSavedAt !== null && this.state.board.homework[cardKey]) {
      const homework = { ...this.state.board.homework }
      delete homework[cardKey]
      this.patch({
        board: { ...this.state.board, homework },
        updatedAt: currentSavedAt,
        dirty: false,
        queued: currentQueued,
        offline: currentQueued,
      })
    }

    if (!cleanupFailed) toast.success('已删除', '考试配置已移除')
    return true
  }

  /* ---------------------------------------------------------------- */
  /* 同步                                                              */
  /* ---------------------------------------------------------------- */

  private pollIntervalMs(): number {
    if (getSetting<boolean>('refresh.auto')) {
      const seconds = getSetting<number>('refresh.interval') || 300
      return Math.max(10, seconds) * 1000
    }
    return 15000
  }

  private startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, this.pollIntervalMs())
  }

  private async pollOnce() {
    if (getSetting<string>('server.provider') !== 'cloud') return
    if (!getSetting<boolean>('sync.realtime')) return
    if (this.state.dirty || this.state.saving) return
    if (typeof document !== 'undefined' && document.hidden) return

    // 花名册/科目/考试也做低频同步，避免多端只同步作业板
    if (Date.now() - this.lastCatalogPoll > 60_000) {
      this.lastCatalogPoll = Date.now()
      void this.loadCatalog()
    }

    try {
      const entry = await getClient().get<BoardData>(KEYS.board(this.state.dateKey))
      if (!entry) return
      // 请求期间用户开始编辑：放弃本次远程更新
      if (this.state.dirty || this.state.saving) return
      if (entry.updatedAt !== this.state.updatedAt) {
        this.patch({
          board: normalizeBoard(entry.value),
          updatedAt: entry.updatedAt,
          offline: Boolean(entry.stale),
          lastRefresh: Date.now(),
        })
      }
    } catch {
      /* 轮询失败静默处理，避免打扰 */
    }
  }

  private bindChannel() {
    if (this.channelBound) return
    this.channelBound = true
    syncChannel?.addEventListener('message', (event: MessageEvent) => {
      const data = event.data as { type?: string; key?: string }
      if (data?.type !== 'change') return
      if (data.key === KEYS.board(this.state.dateKey)) {
        if (!this.state.dirty && !this.state.saving) void this.loadBoard(true)
      } else if (data.key === KEYS.students || data.key === KEYS.subjects || data.key === KEYS.exams) {
        void this.loadCatalog()
      }
    })
  }

  /** 同步连接相关的设置变更后自动重建客户端 */
  private bindSettings() {
    if (this.settingsBound) return
    this.settingsBound = true
    window.addEventListener('classworks-lite:settings', (event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key
      if (!key) return
      if (key === 'refresh.auto' || key === 'refresh.interval') {
        this.startPolling()
        return
      }
      if (key !== 'server.provider' && key !== 'server.domain' && key !== 'server.siteKey') return
      if (key === 'server.provider') {
        // 存储模式切换（含恢复默认）立即生效，避免界面显示本地而客户端仍连云端
        if (this.settingsTimer) clearTimeout(this.settingsTimer)
        this.settingsTimer = null
        void this.reinitialize()
        return
      }
      if (this.settingsTimer) clearTimeout(this.settingsTimer)
      this.settingsTimer = setTimeout(() => {
        void this.reinitialize()
      }, 600)
    })
  }

  /** 访问状态变化：获得编辑权限后补存本地改动，被锁定时停止自动保存 */
  private bindAccess() {
    if (this.accessBound) return
    this.accessBound = true
    window.addEventListener(ACCESS_STATUS_EVENT, this.handleAccessStatus)
  }

  private handleAccessStatus = () => {
    if (isEditLocked()) {
      this.flushPendingSave()
      return
    }
    if (this.state.dirty && !this.state.saving) this.scheduleSave()
  }

  private handleOnline = async () => {
    this.patch({ offline: false })
    const flushed = await getClient().flush()
    if (flushed > 0) {
      toast.success('网络已恢复', `已补传 ${flushed} 条离线改动`)
      this.patch({ pendingSync: await getClient().pendingCount() })
      // 补传后把本地时间戳换成服务端时间戳，并刷新目录版本
      if (!this.state.dirty && !this.state.saving) {
        void this.loadBoard(true)
        void this.loadCatalog()
      }
    }
  }

  private handleOffline = () => {
    this.patch({ offline: true })
  }

  private handleSyncError = (event: Event) => {
    const detail = (event as CustomEvent<{ message?: string }>).detail
    toast.warning('同步冲突', detail?.message ?? '离线改动与云端版本冲突，已保留本机副本')
    void getClient()
      .pendingCount()
      .then((count) => this.patch({ pendingSync: count }))
      .catch(() => undefined)
  }

  private handleVisibility = () => {
    if (!document.hidden && getSetting<string>('server.provider') === 'cloud') {
      void this.pollOnce()
    }
  }

  /** 设置变更后重建客户端并重新载入 */
  async reinitialize(): Promise<boolean> {
    this.flushPendingSave()
    if (this.state.dirty) {
      const ok = await this.save({ silent: true, auto: this.canAutoSave() })
      if (!ok && this.state.dirty) {
        toast.warning('未切换数据源', '当前改动尚未保存，请先上传或撤销')
        return false
      }
    }
    const mode = refreshClient()
    this.patch({ source: mode, status: 'loading', loaded: false, catalogLoaded: false })
    const [catalogOk, boardOk] = await Promise.all([this.loadCatalog(), this.loadBoard(true)])
    if (!catalogOk) toast.warning('部分配置加载失败', '学生名单/科目/考试仍使用本地数据')
    return boardOk
  }

  /**
   * 写入一份示例作业，仅用于演示与验收。
   * 不会覆盖已有内容，只在当前日期为空时生效。
   */
  async seedDemo() {
    const existing = Object.entries(this.state.board.homework).filter(([, item]) => item.content?.trim())
    if (existing.length > 0) {
      toast.info('已有内容', '示例数据只在空白作业板上写入')
      return false
    }

    const demo: Record<string, string> = {
      语文: '《赤壁赋》背诵全文，明天课上抽查\n文言实词整理：第 3 单元 20 个\n作文提纲：以「边界」为题，不少于 800 字',
      数学: '必修二 P88 习题 3.1 第 1—8 题\n错题本整理：圆锥曲线 5 道\n预习 3.2 直线与圆的位置关系',
      英语: 'Unit 5 单词默写（第二遍）\n阅读训练：完形填空 2 篇\n听力精听：VOA 慢速 10 分钟',
      物理: '实验报告：验证牛顿第二定律\n课后练习 P56 第 4、6、9 题',
      化学: '《化学反应原理》P102 第 2—5 题\n背记常见离子方程式 15 个',
      生物: '遗传规律思维导图（A4 纸）\n课本 P76 思考与讨论',
      政治: '时政评述：本周一则国际新闻，200 字',
      历史: '整理「近代化探索」时间轴\n背记 1840—1919 重大事件',
    }

    const homework: Record<string, { content: string }> = {}
    for (const [subject, content] of Object.entries(demo)) homework[subject] = { content }

    let attendance = this.state.board.attendance
    if (this.state.students.length >= 10) {
      attendance = {
        absent: [this.state.students[2], this.state.students[7]],
        late: [this.state.students[4]],
        exclude: [],
      }
    }

    this.patch({ board: { homework, attendance }, dirty: true })
    const saved = await this.save({ silent: true })
    if (saved) toast.success('已载入示例作业', '可直接编辑或清空')
    return saved
  }

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.settingsTimer) clearTimeout(this.settingsTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
      window.removeEventListener('classworks-lite:sync-error', this.handleSyncError)
      window.removeEventListener(ACCESS_STATUS_EVENT, this.handleAccessStatus)
      document.removeEventListener('visibilitychange', this.handleVisibility)
    }
    this.initialized = false
  }
}

export const store = new BoardStore()

/* ------------------------------------------------------------------ */
/* 派生数据                                                            */
/* ------------------------------------------------------------------ */

export function subjectContent(board: BoardData, name: string): string {
  return board.homework[name]?.content ?? ''
}

export function countLines(content: string): number {
  return content.split('\n').filter((line) => line.trim()).length
}

export function attendanceStats(board: BoardData, students: string[]) {
  const names = new Set(students)
  // 历史看板可能残留已从花名册删除的姓名，统计时按当前名单过滤
  const absent = board.attendance.absent.filter((name) => names.has(name))
  const late = board.attendance.late.filter((name) => names.has(name))
  const exclude = board.attendance.exclude.filter((name) => names.has(name))
  const lateCounts = getSetting<boolean>('display.lateStudentsArePresent')
  const expected = Math.max(0, students.length - exclude.length)
  const present = Math.max(
    0,
    students.length - absent.length - exclude.length - (lateCounts ? 0 : late.length),
  )
  return { expected, present, absent: absent.length, late: late.length, exclude: exclude.length }
}

export function isTodayDate(date: Date) {
  return isSameDay(date, today())
}

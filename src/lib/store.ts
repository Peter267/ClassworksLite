/**
 * 应用数据中心。
 *
 * 采用「外部可变 store + useSyncExternalStore」的模式：
 * 全局只有一份状态，卡片、工具栏、对话框共享，避免层层透传 props。
 */

import { DEFAULT_STUDENTS, DEFAULT_SUBJECTS } from './defaults'
import { isSameDay, toDateKey, today } from './date'
import { broadcastChange, getClient, refreshClient, syncChannel } from './kv'
import { getSetting } from './settings'
import { toast } from './toast'
import type { Attendance, BoardData, ExamConfig, HomeworkItem, Subject } from './types'

export const KEYS = {
  board: (dateKey: string) => `classworks-data-${dateKey}`,
  students: 'classworks-list-main',
  subjects: 'classworks-config-subject',
  template: 'classworks-config-homework-template',
  exams: 'classworks-exams',
}

export type AttendanceKind = keyof Attendance

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
  private settingsTimer: ReturnType<typeof setTimeout> | null = null

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

    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')) {
      // 演示数据必须在对外宣布 ready 之前写完，否则 ?edit= 深链会读到空数据
      this.patch({ status: 'loading' })
      await this.seedDemo()
      this.patch({ status: 'ready' })
    }

    this.startPolling()
    this.bindChannel()
    this.bindSettings()

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
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

  private async loadCatalog() {
    const client = getClient()
    try {
      const [studentEntry, subjectEntry, examEntry] = await Promise.all([
        client.get<{ name: string }[] | string[]>(KEYS.students),
        client.get<Subject[]>(KEYS.subjects),
        client.get<ExamConfig[]>(KEYS.exams),
      ])

      const students = Array.isArray(studentEntry?.value)
        ? studentEntry.value
            .map((item) => (typeof item === 'string' ? item : item?.name))
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
        : null

      const subjects =
        Array.isArray(subjectEntry?.value) && subjectEntry.value.length > 0
          ? subjectEntry.value
              .filter((item) => item && typeof item.name === 'string')
              .map((item, index) => ({ name: item.name, order: item.order ?? index }))
              .sort((a, b) => a.order - b.order)
          : null

      this.patch({
        students: students && students.length > 0 ? students : DEFAULT_STUDENTS,
        subjects: subjects ?? DEFAULT_SUBJECTS,
        exams: Array.isArray(examEntry?.value) ? examEntry.value : [],
        pendingSync: await client.pendingCount(),
      })
    } catch (err) {
      console.warn('[store] 配置加载失败', err)
    }
  }

  async loadBoard(force = false) {
    const client = getClient()
    const key = KEYS.board(this.state.dateKey)
    const dateKey = this.state.dateKey
    const seq = (this.loadSeq += 1)
    this.patch({ status: this.state.status === 'ready' && !force ? 'ready' : 'loading' })

    try {
      const entry = await client.get<BoardData>(key)
      // 期间又切换了日期 / 发起了更新的读取：丢弃本次结果
      if (seq !== this.loadSeq || dateKey !== this.state.dateKey) return
      this.patch({
        board: entry ? normalizeBoard(entry.value) : emptyBoard(),
        updatedAt: entry?.updatedAt ?? null,
        status: 'ready',
        error: null,
        dirty: false,
        queued: Boolean(entry?.pending),
        offline: Boolean(entry?.stale),
        lastRefresh: Date.now(),
      })
    } catch (err) {
      if (seq !== this.loadSeq || dateKey !== this.state.dateKey) return
      const message = err instanceof Error ? err.message : '数据加载失败'
      this.patch({ status: 'error', error: message })
    }
  }

  async refresh() {
    if (this.state.dirty) {
      toast.warning('有未保存的改动', '请先上传或撤销，再刷新数据')
      return
    }
    const before = this.state.updatedAt
    await this.loadBoard(true)
    if (this.state.updatedAt !== before) {
      toast.info('已刷新', '数据已更新到最新')
    } else {
      toast.success('已刷新', '当前已是最新数据')
    }
  }

  /* ---------------------------------------------------------------- */
  /* 日期                                                              */
  /* ---------------------------------------------------------------- */

  async goToDate(date: Date) {
    if (isSameDay(date, this.state.date)) return
    // 切换日期前先落盘；落盘失败或用户取消时不得继续，否则改动会被空板覆盖（D4）
    if (this.state.dirty) {
      const ok = await this.save({ silent: true, auto: this.canAutoSave() })
      if (!ok) {
        if (this.state.dirty) toast.warning('未切换日期', '当前改动尚未保存，请先上传或撤销')
        return
      }
    }
    this.patch({
      date,
      dateKey: toDateKey(date),
      board: emptyBoard(),
      dirty: false,
      updatedAt: null,
      status: 'loading',
    })
    await this.loadBoard(true)
  }

  /* ---------------------------------------------------------------- */
  /* 作业编辑                                                          */
  /* ---------------------------------------------------------------- */

  private commitBoard(next: BoardData) {
    this.patch({ board: next, dirty: true })
    this.scheduleSave()
  }

  setHomework(subject: string, content: string) {
    const homework = { ...this.state.board.homework }
    const existing = homework[subject]
    const trimmed = content.trim()
    if (!trimmed) {
      // 清空即删除；考试卡片保留（由考试看板管理）
      if (existing?.type === 'exam') return
      delete homework[subject]
    } else {
      homework[subject] = { ...(existing ?? {}), content: trimmed }
    }
    this.commitBoard({ ...this.state.board, homework })
  }

  removeHomework(subject: string) {
    const homework = { ...this.state.board.homework }
    delete homework[subject]
    this.commitBoard({ ...this.state.board, homework })
  }

  addCustomCard(name = '自定义卡片', content = '') {
    const key = `custom-${Date.now()}`
    const homework = {
      ...this.state.board.homework,
      [key]: { name, content, type: 'custom' as const },
    }
    this.commitBoard({ ...this.state.board, homework })
    return key
  }

  renameCustomCard(key: string, name: string) {
    const item = this.state.board.homework[key]
    if (!item) return
    this.commitBoard({
      ...this.state.board,
      homework: { ...this.state.board.homework, [key]: { ...item, name } },
    })
  }

  addExamCard(examId: string) {
    const key = `exam-${examId}`
    const homework = { ...this.state.board.homework }
    if (homework[key]) delete homework[key]
    else homework[key] = { type: 'exam', examId, name: '考试安排', content: '' }
    this.commitBoard({ ...this.state.board, homework })
    return Boolean(homework[key])
  }

  /* ---------------------------------------------------------------- */
  /* 跨日期操作                                                        */
  /* ---------------------------------------------------------------- */

  /** 把当前日期的作业复制到今天（只补空缺，不覆盖已有内容） */
  async copyToToday(): Promise<number> {
    const targetDate = today()
    const targetKey = toDateKey(targetDate)
    if (targetKey === this.state.dateKey) return 0

    const client = getClient()
    const entry = await client.get<BoardData>(KEYS.board(targetKey))
    const target = entry ? normalizeBoard(entry.value) : emptyBoard()

    let count = 0
    for (const [key, item] of Object.entries(this.state.board.homework)) {
      if (!item.content?.trim()) continue
      if (target.homework[key]?.content?.trim()) continue
      target.homework[key] = { ...item }
      count += 1
    }
    if (count === 0) return 0

    await client.set(KEYS.board(targetKey), target)
    broadcastChange(KEYS.board(targetKey))
    if (this.state.dirty) this.flushPendingSave()
    this.patch({
      date: targetDate,
      dateKey: targetKey,
      board: target,
      dirty: false,
      updatedAt: Date.now(),
      status: 'ready',
    })
    return count
  }

  /* ---------------------------------------------------------------- */
  /* 出勤                                                              */
  /* ---------------------------------------------------------------- */

  setAttendance(kind: AttendanceKind, names: string[]) {
    // 批量登记同样要保证「一人一种状态」，否则统计会重复扣减（F2）
    const unique = Array.from(new Set(names))
    const next: Attendance = { ...this.state.board.attendance, [kind]: unique }
    for (const other of ['absent', 'late', 'exclude'] as AttendanceKind[]) {
      if (other === kind) continue
      next[other] = next[other].filter((name) => !unique.includes(name))
    }
    this.commitBoard({ ...this.state.board, attendance: next })
  }

  toggleAttendance(name: string, kind: AttendanceKind) {
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
    this.commitBoard({ ...this.state.board, attendance: next })
  }

  clearAttendance() {
    this.commitBoard({ ...this.state.board, attendance: { absent: [], late: [], exclude: [] } })
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
      const { entry, queued } = await getClient().set(key, snapshot)
      // 保存期间又有新的编辑：保持 dirty，稍后继续保存（D3）
      const changedWhileSaving = this.state.board !== snapshot
      this.patch({
        saving: false,
        dirty: changedWhileSaving,
        queued,
        updatedAt: entry.updatedAt,
        offline: queued,
        pendingSync: await getClient().pendingCount(),
      })
      if (changedWhileSaving) this.scheduleSave()
      broadcastChange(key)
      if (queued) {
        toast.warning('已保存到本地', '网络恢复后会自动同步到云端')
      } else if (!opts.silent) {
        toast.success('保存成功', '已同步作业数据')
      }
      return true
    } catch (err) {
      this.patch({ saving: false })
      toast.error('保存失败', err instanceof Error ? err.message : '请检查同步配置')
      return false
    }
  }

  /* ---------------------------------------------------------------- */
  /* 学生 / 科目 / 考试                                                 */
  /* ---------------------------------------------------------------- */

  async setStudents(names: string[]) {
    const clean = Array.from(new Set(names.map((n) => n.trim()).filter(Boolean)))
    this.patch({ students: clean })
    const { queued } = await getClient().set(
      KEYS.students,
      clean.map((name) => ({ name })),
    )
    broadcastChange(KEYS.students)
    if (queued) toast.warning('已保存到本地', '学生名单将在联网后同步')
  }

  async setSubjects(subjects: Subject[]) {
    const previous = this.state.subjects.map((item) => item.name)
    const clean = subjects
      .map((s, index) => ({ name: s.name.trim(), order: index }))
      .filter((s) => s.name.length > 0)
    const nextNames = clean.map((item) => item.name)

    // 同步位置的旧名 → 新名视为改名；仅调整顺序时集合不变，不会误判
    const removed = previous.filter((name) => !nextNames.includes(name))
    const renames: { from: string; to: string }[] = []
    for (const from of removed) {
      const index = previous.indexOf(from)
      const candidate = nextNames[index]
      if (!candidate || previous.includes(candidate)) continue
      if (renames.some((item) => item.to === candidate)) continue
      renames.push({ from, to: candidate })
    }

    this.patch({ subjects: clean })
    const { queued } = await getClient().set(KEYS.subjects, clean)
    broadcastChange(KEYS.subjects)
    if (queued) toast.warning('已保存到本地', '科目表将在联网后同步')

    // 改名后迁移历史作业键，否则旧作业会留在孤立键里（D7）
    for (const item of renames) await this.renameSubject(item.from, item.to)
    return { renamed: renames.length, queued }
  }

  /**
   * 科目改名：把各日期作业板里的旧键迁移到新键，避免旧作业变成看不见的孤立数据（D7）。
   * 返回实际迁移的日期数量。
   */
  async renameSubject(from: string, to: string): Promise<number> {
    const target = to.trim()
    if (!from || !target || target === from) return 0
    const client = getClient()
    const currentKey = KEYS.board(this.state.dateKey)

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
      const keys = await client.list(KEYS.board(''))
      for (const { key } of keys) {
        if (key === currentKey) continue
        const entry = await client.get<BoardData>(key)
        if (!entry) continue
        const board = normalizeBoard(entry.value)
        if (!board.homework[from]) continue
        board.homework[target] = { ...board.homework[from] }
        delete board.homework[from]
        await client.set(key, board)
        migrated += 1
      }
    } catch (err) {
      console.warn('[store] 科目改名迁移中断', err)
      toast.warning('历史作业迁移未完成', '部分日期的作业可能仍需手动处理')
    }
    if (migrated > 0) toast.success('已迁移历史作业', `${migrated} 个日期`)
    return migrated
  }

  async saveExam(exam: ExamConfig) {
    const exists = this.state.exams.some((item) => item.id === exam.id)
    const next = exists
      ? this.state.exams.map((item) => (item.id === exam.id ? exam : item))
      : [...this.state.exams, exam]
    this.patch({ exams: next })
    await getClient().set(KEYS.exams, next)
    broadcastChange(KEYS.exams)
    toast.success('已保存', exam.examName)
  }

  async deleteExam(id: string) {
    const next = this.state.exams.filter((item) => item.id !== id)
    this.patch({ exams: next })
    await getClient().set(KEYS.exams, next)
    broadcastChange(KEYS.exams)
    toast.success('已删除', '考试配置已移除')
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

    try {
      const entry = await getClient().get<BoardData>(KEYS.board(this.state.dateKey))
      if (!entry) return
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

  private handleOnline = async () => {
    this.patch({ offline: false })
    const flushed = await getClient().flush()
    if (flushed > 0) {
      toast.success('网络已恢复', `已补传 ${flushed} 条离线改动`)
      this.patch({ pendingSync: await getClient().pendingCount() })
    }
  }

  private handleOffline = () => {
    this.patch({ offline: true })
  }

  private handleVisibility = () => {
    if (!document.hidden && getSetting<string>('server.provider') === 'cloud') {
      void this.pollOnce()
    }
  }

  /** 设置变更后重建客户端并重新载入 */
  async reinitialize() {
    this.flushPendingSave()
    const mode = refreshClient()
    this.patch({ source: mode, status: 'loading' })
    await Promise.all([this.loadCatalog(), this.loadBoard(true)])
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
    await this.save({ silent: true })
    toast.success('已载入示例作业', '可直接编辑或清空')
    return true
  }

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.settingsTimer) clearTimeout(this.settingsTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
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

export function attendanceStats(board: BoardData, studentCount: number) {
  const { absent, late, exclude } = board.attendance
  const lateCounts = getSetting<boolean>('display.lateStudentsArePresent')
  const expected = Math.max(0, studentCount - exclude.length)
  const present = Math.max(0, studentCount - absent.length - exclude.length - (lateCounts ? 0 : late.length))
  return { expected, present, absent: absent.length, late: late.length, exclude: exclude.length }
}

export function isTodayDate(date: Date) {
  return isSameDay(date, today())
}

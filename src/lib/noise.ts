/**
 * 环境噪音监测服务。
 *
 * 与上游 `@wydev/noise-core` 的公开接口保持一致的子集：
 *   noiseService.start() / stop() / subscribe(fn) / calibrate(target, cb)
 *   noiseService.getHistory() / clearHistory()
 *   getNoiseControlSettings() / saveNoiseControlSettings() / resetNoiseControlSettings()
 *
 * 采集链路：getUserMedia → AnalyserNode（时域 RMS）→ 校准换算为显示分贝，
 * 200ms 一个采样切片，1s 计算一次评分。音频只在本地处理，不上传、不存储录音。
 */

export type NoiseStatus = 'initializing' | 'active' | 'paused' | 'permission-denied' | 'error'

export interface NoiseSlice {
  t: number
  dbfs: number
  displayDb: number
}

export interface NoiseScoreDetail {
  sustainedPenalty: number
  timePenalty: number
  segmentPenalty: number
}

export interface NoiseSnapshot {
  status: NoiseStatus
  currentDbfs: number
  currentDisplayDb: number
  ringBuffer: NoiseSlice[]
  lastSlice: NoiseSlice | null
  currentScore: number | null
  currentScoreDetail: NoiseScoreDetail | null
}

export interface NoiseReport {
  id: string
  date: string
  sessionName: string
  startTime: number
  endTime: number
  duration: number
  samples: { t: number; db: number }[]
  score: number
  avgDb: number
  maxDb: number
  overThresholdDuration: number
  segmentCount: number
  alertThresholdDb: number
  scorePenalties: { sustained: number; time: number; segment: number }
}

export interface NoiseControlSettings {
  baselineDb: number
  baselineRms: number | null
  maxLevelDb: number
}

export type MicPermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable' | ''

export interface NoiseSession {
  name: string
  start: string
  duration: number
  enabled: boolean
}

export interface NoiseSessionConfig {
  sessions: NoiseSession[]
  alertThresholdDb: number
}

export interface NoiseSchedule extends NoiseSessionConfig {
  autoStart: boolean
  permission: MicPermissionState
}

/** 当前生效的晚自习时段；重叠时取开始时间最晚的一段 */
export function activeSession(
  config: NoiseSchedule | NoiseSessionConfig | null,
  now = new Date(),
): NoiseSession | null {
  if (!config?.sessions) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  let matched: NoiseSession | null = null
  let matchedStart = -1
  for (const session of config.sessions) {
    if (!session.enabled || !session.start) continue
    const [h, m] = session.start.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) continue
    const start = h * 60 + m
    const duration = session.duration || 0
    if (duration <= 0) continue
    // 环形偏移支持 23:30 开始、跨到次日 00:30 的时段
    const offset = (minutes - start + 1440) % 1440
    if (offset < duration && start > matchedStart) {
      matched = session
      matchedStart = start
    }
  }
  return matched
}

function sessionKey(session: NoiseSession | null): string | null {
  return session ? `${session.name}|${session.start}` : null
}

function dateKey(timestamp: number) {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

const CALIBRATION_KEY = 'classworks-noise-calibration'
const REPORTS_KEY = 'classworks-noise-reports'
const DEFAULT_CALIBRATION: NoiseControlSettings = {
  baselineDb: 40,
  baselineRms: 0.0032,
  maxLevelDb: 100,
}

export function getNoiseControlSettings(): NoiseControlSettings {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY)
    if (!raw) return { ...DEFAULT_CALIBRATION }
    const parsed = JSON.parse(raw) as Partial<NoiseControlSettings>
    return {
      baselineDb: Number(parsed.baselineDb) || DEFAULT_CALIBRATION.baselineDb,
      baselineRms:
        parsed.baselineRms === null || parsed.baselineRms === undefined
          ? DEFAULT_CALIBRATION.baselineRms
          : Number(parsed.baselineRms),
      maxLevelDb: Number(parsed.maxLevelDb) || DEFAULT_CALIBRATION.maxLevelDb,
    }
  } catch {
    return { ...DEFAULT_CALIBRATION }
  }
}

export function saveNoiseControlSettings(patch: Partial<NoiseControlSettings>) {
  const next = { ...getNoiseControlSettings(), ...patch }
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
  service.applyCalibration(next)
  return next
}

export function resetNoiseControlSettings() {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(DEFAULT_CALIBRATION))
  } catch {
    /* ignore */
  }
  service.applyCalibration({ ...DEFAULT_CALIBRATION })
  return { ...DEFAULT_CALIBRATION }
}

/* ------------------------------------------------------------------ */
/* 报告存储                                                            */
/* ------------------------------------------------------------------ */

function readReports(): NoiseReport[] {
  try {
    const raw = localStorage.getItem(REPORTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as NoiseReport[]) : []
  } catch {
    return []
  }
}

function writeReports(reports: NoiseReport[]) {
  try {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(reports.slice(-40)))
  } catch {
    /* ignore */
  }
}

export function getReportMeta() {
  const dates: Record<string, { count: number; avgScore: number; sessions: string[] }> = {}
  for (const report of readReports()) {
    const entry = dates[report.date] ?? { count: 0, avgScore: 0, sessions: [] }
    const total = entry.avgScore * entry.count + report.score
    entry.count += 1
    entry.avgScore = Math.round(total / entry.count)
    entry.sessions.push(report.sessionName)
    dates[report.date] = entry
  }
  return { dates }
}

export function getReportsByDate(date: string): NoiseReport[] {
  return readReports()
    .filter((report) => report.date === date)
    .sort((a, b) => a.startTime - b.startTime)
}

export function clearReports(date?: string) {
  if (!date) {
    writeReports([])
    return
  }
  writeReports(readReports().filter((report) => report.date !== date))
}

/* ------------------------------------------------------------------ */
/* 服务                                                                */
/* ------------------------------------------------------------------ */

const SAMPLE_INTERVAL = 200
const WINDOW_MS = 60_000
const RING_CAPACITY = 300

class NoiseService {
  private status: NoiseStatus = 'initializing'
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private buffer: Float32Array | null = null
  private timer: number | null = null
  private listeners = new Set<(snapshot: NoiseSnapshot) => void>()
  private calibration = getNoiseControlSettings()

  private ringBuffer: NoiseSlice[] = []
  private lastSlice: NoiseSlice | null = null
  private currentDbfs = -100
  private currentDisplayDb = 0
  private currentScore: number | null = null
  private currentScoreDetail: NoiseScoreDetail | null = null

  private windowSlices: NoiseSlice[] = []
  private sustainedStreak = 0
  private segments = 0
  private wasLoud = false

  private sessionStart = 0
  private sessionName = '自由监测'
  private sessionSamples: { t: number; db: number }[] = []
  private overThresholdMs = 0
  private alertThresholdDb = 55
  /** 启动代次：stop 或新的 start 都会让在途的授权流程失效（F13） */
  private generation = 0
  private schedule: NoiseSchedule | null = null
  private scheduleTimer: number | null = null
  private starting = false
  private suppressedSessionKey: string | null = null

  getStatus() {
    return this.status
  }

  getSessionName() {
    return this.sessionName
  }

  applyCalibration(next: NoiseControlSettings) {
    this.calibration = next
  }

  setSession(name: string, alertThresholdDb: number) {
    this.sessionName = name
    this.alertThresholdDb = alertThresholdDb
  }

  /** 由 UI 注入时段配置；服务层自己维护定时器，路由切换不会中断监测 */
  setSchedule(schedule: NoiseSchedule | null) {
    this.schedule = schedule
      ? {
          ...schedule,
          sessions: schedule.sessions.map((session) => ({ ...session })),
        }
      : null
    if (this.scheduleTimer) {
      window.clearInterval(this.scheduleTimer)
      this.scheduleTimer = null
    }
    if (!this.schedule) return
    this.evaluateSchedule()
    this.scheduleTimer = window.setInterval(() => this.evaluateSchedule(), 30_000)
  }

  /** 设置页修改时段后立即生效，保留自动开始与权限状态 */
  updateScheduleConfig(config: NoiseSessionConfig) {
    if (!this.schedule) return
    this.setSchedule({
      ...this.schedule,
      sessions: config.sessions,
      alertThresholdDb: config.alertThresholdDb,
    })
  }

  setPermission(permission: MicPermissionState) {
    if (!this.schedule) return
    if (this.schedule.permission === permission) return
    this.schedule.permission = permission
    this.evaluateSchedule()
  }

  setAutoStart(autoStart: boolean) {
    if (!this.schedule) return
    if (this.schedule.autoStart === autoStart) return
    this.schedule.autoStart = autoStart
    this.evaluateSchedule()
  }

  private evaluateSchedule() {
    if (!this.schedule) return
    const current = activeSession(this.schedule)
    const currentKey = sessionKey(current)
    if (!current) {
      this.suppressedSessionKey = null
      if (this.status === 'active' && this.sessionName !== '自由监测') this.stop()
      return
    }
    if (this.suppressedSessionKey && this.suppressedSessionKey !== currentKey) {
      this.suppressedSessionKey = null
    }
    const threshold = this.schedule.alertThresholdDb ?? 55
    if (this.status === 'active') {
      if (this.sessionName !== current.name) {
        // 时段切换：归档上一节，再以新时段继续采集（不重新申请麦克风）
        this.finalizeReport()
        this.beginSession(current.name, threshold)
        this.emit()
      } else {
        this.alertThresholdDb = threshold
      }
      return
    }
    if (this.starting) return
    if (!this.schedule.autoStart || this.schedule.permission !== 'granted') return
    if (this.suppressedSessionKey === currentKey) return
    if (this.status === 'permission-denied' || this.status === 'error') return
    void this.startCurrent().catch(() => undefined)
  }

  /** 手动开始：当前处于时段内则使用时段名，否则作为自由监测 */
  async startCurrent() {
    const current = activeSession(this.schedule)
    this.suppressedSessionKey = null
    this.setSession(
      current?.name ?? '自由监测',
      this.schedule?.alertThresholdDb ?? 55,
    )
    return this.start()
  }

  subscribe(fn: (snapshot: NoiseSnapshot) => void) {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => {
      this.listeners.delete(fn)
    }
  }

  snapshot(): NoiseSnapshot {
    return {
      status: this.status,
      currentDbfs: this.currentDbfs,
      currentDisplayDb: this.currentDisplayDb,
      ringBuffer: [...this.ringBuffer],
      lastSlice: this.lastSlice,
      currentScore: this.currentScore,
      currentScoreDetail: this.currentScoreDetail,
    }
  }

  private emit() {
    const snap = this.snapshot()
    this.listeners.forEach((fn) => fn(snap))
  }

  private beginSession(name: string, alertThresholdDb: number) {
    this.sessionName = name
    this.alertThresholdDb = alertThresholdDb
    this.sessionStart = Date.now()
    this.sessionSamples = []
    this.overThresholdMs = 0
    this.segments = 0
    this.wasLoud = false
    this.sustainedStreak = 0
    this.windowSlices = []
    this.ringBuffer = []
    this.lastSlice = null
    this.currentScore = null
    this.currentScoreDetail = null
    this.currentDisplayDb = 0
  }

  async start() {
    if (this.status === 'active' || this.starting) return
    this.starting = true
    const generation = (this.generation += 1)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      // 授权期间被 stop 或被新的 start 取代：丢弃这条流，不创建定时器（F13）
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      this.stream = stream
      const AudioCtx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AudioCtx()
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      if (generation !== this.generation) {
        void this.ctx.close()
        this.ctx = null
        this.stream?.getTracks().forEach((track) => track.stop())
        this.stream = null
        return
      }
      this.analyser = this.ctx.createAnalyser()
      this.analyser.fftSize = 2048
      this.source = this.ctx.createMediaStreamSource(this.stream)
      this.source.connect(this.analyser)
      this.buffer = new Float32Array(this.analyser.fftSize)

      this.calibration = getNoiseControlSettings()
      this.beginSession(this.sessionName, this.alertThresholdDb)
      this.status = 'active'
      this.timer = window.setInterval(() => this.tick(), SAMPLE_INTERVAL)
      this.emit()
    } catch (error) {
      // 授权成功但 AudioContext/分析器初始化失败时，必须释放麦克风
      this.source?.disconnect()
      this.stream?.getTracks().forEach((track) => track.stop())
      void this.ctx?.close()
      this.ctx = null
      this.stream = null
      this.analyser = null
      this.source = null
      this.buffer = null
      if (generation !== this.generation) return
      const err = error as DOMException
      this.status =
        err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
          ? 'permission-denied'
          : 'error'
      this.emit()
      throw error
    } finally {
      this.starting = false
    }
  }

  stop(options: { manual?: boolean } = {}) {
    if (options.manual && this.schedule) {
      this.suppressedSessionKey = sessionKey(activeSession(this.schedule))
    }
    // 让在途的启动流程失效
    this.generation += 1
    if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    this.source?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.ctx?.close()
    this.ctx = null
    this.stream = null
    this.analyser = null
    this.source = null
    if (this.status === 'active') this.finalizeReport()
    this.status = 'paused'
    this.currentScore = null
    this.currentScoreDetail = null
    this.ringBuffer = []
    this.lastSlice = null
    this.currentDisplayDb = 0
    this.emit()
  }

  private tick() {
    if (!this.analyser || !this.buffer) return
    this.analyser.getFloatTimeDomainData(this.buffer as Float32Array<ArrayBuffer>)
    let sum = 0
    for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i]
    const rms = Math.sqrt(sum / this.buffer.length)
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : -100
    const baselineRms = this.calibration.baselineRms || DEFAULT_CALIBRATION.baselineRms || 0.0032
    const raw = this.calibration.baselineDb + 20 * Math.log10(Math.max(rms, 1e-6) / baselineRms)
    const displayDb = Math.max(0, Math.min(this.calibration.maxLevelDb, raw))

    const slice: NoiseSlice = { t: Date.now(), dbfs, displayDb }
    this.currentDbfs = dbfs
    this.currentDisplayDb = displayDb
    this.lastSlice = slice
    this.ringBuffer.push(slice)
    if (this.ringBuffer.length > RING_CAPACITY) this.ringBuffer.shift()

    this.windowSlices.push(slice)
    const cutoff = slice.t - WINDOW_MS
    this.windowSlices = this.windowSlices.filter((item) => item.t >= cutoff)

    // 会话采样（1s 粒度）
    if (
      this.sessionSamples.length === 0 ||
      slice.t - this.sessionSamples[this.sessionSamples.length - 1].t >= 1000
    ) {
      this.sessionSamples.push({ t: slice.t, db: displayDb })
    }

    const loud = displayDb > this.alertThresholdDb
    if (loud) {
      this.overThresholdMs += SAMPLE_INTERVAL
      this.sustainedStreak += 1
      if (!this.wasLoud) this.segments += 1
    } else {
      this.sustainedStreak = 0
    }
    this.wasLoud = loud

    this.computeScore()
    this.emit()
  }

  private computeScore() {
    if (this.windowSlices.length < 5) {
      this.currentScore = null
      this.currentScoreDetail = null
      return
    }
    const total = this.windowSlices.length
    const loudCount = this.windowSlices.filter((item) => item.displayDb > this.alertThresholdDb).length
    const ratio = loudCount / total

    // 持续：最长连续超阈值（以 200ms 切片计，约 2 秒才明显扣分）
    let streak = 0
    let maxStreak = 0
    let windowSegments = 0
    let wasLoud = false
    for (const item of this.windowSlices) {
      const loud = item.displayDb > this.alertThresholdDb
      if (loud) {
        streak += 1
        maxStreak = Math.max(maxStreak, streak)
        if (!wasLoud) windowSegments += 1
      } else {
        streak = 0
      }
      wasLoud = loud
    }
    const sustainedPenalty = Math.min(40, Math.round(maxStreak * 0.4))
    const timePenalty = Math.min(30, Math.round(ratio * 30))
    // 与报告口径一致：窗口内每次“由静到吵”计 3 分，第一次不扣
    const segmentPenalty = Math.min(30, Math.max(0, (windowSegments - 1) * 3))

    const score = Math.max(0, Math.min(100, 100 - sustainedPenalty - timePenalty - segmentPenalty))
    this.currentScore = score
    this.currentScoreDetail = { sustainedPenalty, timePenalty, segmentPenalty }
  }

  private finalizeReport() {
    // 报告只针对晚自习时段生成；自由监测不落盘（与上游一致）
    if (this.sessionName === '自由监测') return
    const end = Date.now()
    const duration = end - this.sessionStart
    if (duration < 60_000 || this.sessionSamples.length < 10) return

    const dbs = this.sessionSamples.map((sample) => sample.db)
    const avgDb = Math.round(dbs.reduce((a, b) => a + b, 0) / dbs.length)
    const maxDb = Math.round(Math.max(...dbs))
    const loudCount = dbs.filter((db) => db > this.alertThresholdDb).length
    const ratio = loudCount / dbs.length

    let streak = 0
    let maxStreak = 0
    let segments = 0
    let wasLoud = false
    for (const db of dbs) {
      const loud = db > this.alertThresholdDb
      if (loud) {
        streak += 1
        maxStreak = Math.max(maxStreak, streak)
        if (!wasLoud) segments += 1
      } else {
        streak = 0
      }
      wasLoud = loud
    }

    const sustained = Math.min(40, Math.round(maxStreak * 0.4))
    const time = Math.min(30, Math.round(ratio * 30))
    const segment = Math.min(30, Math.max(0, (segments - 1) * 3))
    const score = Math.max(0, 100 - sustained - time - segment)

    // 抽样到最多 1200 点，控制存储体积
    const step = Math.max(1, Math.ceil(this.sessionSamples.length / 1200))
    const samples = this.sessionSamples.filter((_, index) => index % step === 0)

    const report: NoiseReport = {
      id: `noise-${this.sessionStart}`,
      date: dateKey(this.sessionStart),
      sessionName: this.sessionName,
      startTime: this.sessionStart,
      endTime: end,
      duration,
      samples,
      score,
      avgDb,
      maxDb,
      overThresholdDuration: Math.round((loudCount * duration) / dbs.length / 1000),
      segmentCount: segments,
      alertThresholdDb: this.alertThresholdDb,
      scorePenalties: { sustained, time, segment },
    }

    writeReports([...readReports(), report])
  }

  getHistory(): NoiseReport[] {
    return readReports().sort((a, b) => b.startTime - a.startTime)
  }

  clearHistory() {
    writeReports([])
  }

  calibrate(targetDb: number, callback: (success: boolean, message: string) => void) {
    if (this.status !== 'active' || !this.analyser || !this.buffer) {
      callback(false, '请先开始监测')
      return
    }
    const analyser = this.analyser
    const buffer = this.buffer
    const samples: number[] = []
    const started = Date.now()
    let finished = false
    const timer = window.setInterval(() => {
      // 监测被停止或重启：结束校准并回调失败，避免 UI 永远停在「校准中」（F14）
      if (this.analyser !== analyser) {
        window.clearInterval(timer)
        if (!finished) {
          finished = true
          callback(false, '校准已中断，请重新开始监测')
        }
        return
      }
      analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>)
      let sum = 0
      for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i]
      samples.push(Math.sqrt(sum / buffer.length))
      if (Date.now() - started >= 3000) {
        window.clearInterval(timer)
        if (finished) return
        finished = true
        const avg = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)
        if (!Number.isFinite(avg) || avg <= 0) {
          callback(false, '未采集到有效音频，请检查麦克风')
          return
        }
        saveNoiseControlSettings({ baselineDb: targetDb, baselineRms: avg })
        callback(true, `校准完成：基准分贝 ${targetDb} dB`)
      }
    }, 120)
  }
}

export const noiseService = new NoiseService()
const service = noiseService

if (typeof window !== 'undefined') {
  window.addEventListener('classworks-lite:settings', (event) => {
    const detail = (event as CustomEvent<{ key?: string; value?: unknown }>).detail
    if (detail?.key === 'noiseMonitor.enabled' && detail.value === false) {
      noiseService.setSchedule(null)
      noiseService.stop()
    }
    if (detail?.key === 'noiseMonitor.autoStart') {
      noiseService.setAutoStart(detail.value === true)
    }
  })
  // 关闭/刷新页面时尽量归档当前报告
  window.addEventListener('pagehide', () => noiseService.stop())
}

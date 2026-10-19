import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { NoiseMonitorDetail, type MicPermissionState } from './NoiseMonitorDetail'
import { dayProgress, longDate, periodOfDay, weekdayLabel } from '../lib/date'
import { useNow, useSetting } from '../lib/hooks'
import { getClient } from '../lib/kv'
import {
  noiseService,
  type NoiseScoreDetail,
  type NoiseSlice,
  type NoiseStatus,
} from '../lib/noise'
import { settings } from '../lib/settings'

/** 用 WebAudio 合成提示音，避免额外音频资源 */
function beep(times = 3) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    for (let i = 0; i < times; i += 1) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.45)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.45 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.45 + 0.32)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + i * 0.45)
      osc.stop(ctx.currentTime + i * 0.45 + 0.34)
    }
    setTimeout(() => void ctx.close(), times * 500 + 400)
  } catch {
    /* 静默失败 */
  }
}

type FullscreenMode = 'clock' | 'countdown' | 'stopwatch'

const pad = (n: number) => String(n).padStart(2, '0')

function formatCountdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

function formatStopwatch(ms: number) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const cs = Math.floor((ms % 1000) / 10)
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}.${pad(cs)}`
    : `${pad(m)}:${pad(s)}.${pad(cs)}`
}

const COUNTDOWN_PRESETS = [
  { label: '1 分钟', seconds: 60 },
  { label: '3 分钟', seconds: 180 },
  { label: '5 分钟', seconds: 300 },
  { label: '10 分钟', seconds: 600 },
  { label: '15 分钟', seconds: 900 },
  { label: '30 分钟', seconds: 1800 },
  { label: '1 小时', seconds: 3600 },
]

interface NoiseSession {
  name: string
  start: string
  duration: number
  enabled: boolean
}

interface NoiseSessionConfig {
  sessions: NoiseSession[]
  alertThresholdDb: number
}

const DEFAULT_SESSIONS: NoiseSession[] = [
  { name: '第1节晚自习', start: '19:20', duration: 70, enabled: true },
  { name: '第2节晚自习', start: '20:20', duration: 110, enabled: true },
]

function activeSession(config: NoiseSessionConfig | null): NoiseSession | null {
  if (!config?.sessions) return null
  const now = new Date()
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
    // 用环形偏移判断，支持 23:30 开始、跨到次日 00:30 的时段（F15）
    const offset = (minutes - start + 1440) % 1440
    if (offset < duration && start > matchedStart) {
      matched = session
      matchedStart = start
    }
  }
  // 时段重叠时取开始时间最晚的一段（更贴近“当前这一节”）
  return matched
}

async function checkMicPermission(): Promise<MicPermissionState> {
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!devices.some((device) => device.kind === 'audioinput')) return 'unavailable'
    }
    if (!navigator.permissions?.query) return 'granted'
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return result.state as MicPermissionState
  } catch {
    return 'prompt'
  }
}

export function TimeCard() {
  const now = useNow(1000)
  const [use12h] = useSetting<boolean>('timeCard.use12h')
  const [fontSize] = useSetting<number>('font.size')
  const [noiseEnabled] = useSetting<boolean>('noiseMonitor.enabled')
  const [autoStart] = useSetting<boolean>('noiseMonitor.autoStart')
  const [permissionDismissed] = useSetting<boolean>('noiseMonitor.permissionDismissed')
  const [open, setOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(
    () => new URLSearchParams(window.location.search).get('noise') === '1',
  )
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [micPermissionState, setMicPermissionState] = useState<MicPermissionState>('')
  const [status, setStatus] = useState<NoiseStatus>('initializing')
  const [monitoring, setMonitoring] = useState(false)
  const [displayDb, setDisplayDb] = useState(0)
  const [ringBuffer, setRingBuffer] = useState<NoiseSlice[]>([])
  const [score, setScore] = useState<number | null>(null)
  const [scoreDetail, setScoreDetail] = useState<NoiseScoreDetail | null>(null)
  const [sessionConfig, setSessionConfig] = useState<NoiseSessionConfig | null>(null)
  const [sessionName, setSessionName] = useState('自由监测')
  const unsubscribeRef = useRef<null | (() => void)>(null)
  const sessionRef = useRef<NoiseSession | null>(null)

  const hours = now.getHours()
  const displayHour = use12h ? hours % 12 || 12 : hours
  const timeString = `${pad(displayHour)}:${pad(now.getMinutes())}`
  const ampm = hours < 12 ? 'AM' : 'PM'

  const stopNoise = useCallback(() => {
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    noiseService.stop()
    setMonitoring(false)
    setStatus('paused')
    setScore(null)
    setScoreDetail(null)
    setRingBuffer([])
    setDisplayDb(0)
  }, [])

  const startNoise = useCallback(async () => {
    try {
      // 每次启动都按最新配置判断当前时段，避免用打开页面时的空会话启动（F12）
      const session = activeSession(sessionConfig)
      sessionRef.current = session
      noiseService.setSession(
        session?.name ?? '自由监测',
        sessionConfig?.alertThresholdDb ?? 55,
      )
      setSessionName(session?.name ?? '自由监测')
      setDisplayDb(0)
      await noiseService.start()
      setMonitoring(true)
      unsubscribeRef.current = noiseService.subscribe((snapshot) => {
        setStatus(snapshot.status)
        setDisplayDb((previous) =>
          previous === 0 ? snapshot.currentDisplayDb : previous * 0.75 + snapshot.currentDisplayDb * 0.25,
        )
        setRingBuffer(snapshot.ringBuffer)
        setScore(snapshot.currentScore)
        setScoreDetail(snapshot.currentScoreDetail)
      })
    } catch {
      setStatus('error')
    }
  }, [sessionConfig])

  /* 加载晚自习配置（KV） */
  useEffect(() => {
    if (!noiseEnabled) return
    void (async () => {
      try {
        const entry = await getClient().get<NoiseSessionConfig>('noise-session-config')
        setSessionConfig(entry?.value ?? { sessions: DEFAULT_SESSIONS, alertThresholdDb: 55 })
      } catch {
        setSessionConfig({ sessions: DEFAULT_SESSIONS, alertThresholdDb: 55 })
      }
    })()
  }, [noiseEnabled])

  /* 麦克风权限探测（自动启动交给下方的时段判断） */
  useEffect(() => {
    if (!noiseEnabled) return
    let cancelled = false
    void (async () => {
      const state = await checkMicPermission()
      if (cancelled) return
      setMicPermissionState(state)
      if (state === 'prompt' && !permissionDismissed) {
        setPermissionOpen(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseEnabled])

  /* 晚自习时段：进入时段自动开始并接管当前时段，离开时段结束并归档 */
  useEffect(() => {
    if (!noiseEnabled || !sessionConfig) return
    const evaluate = () => {
      const current = activeSession(sessionConfig)
      sessionRef.current = current
      if (current) {
        if (!autoStart || micPermissionState !== 'granted') return
        if (!monitoring) {
          void startNoise()
        } else if (sessionName !== current.name) {
          // 已在自由监测或上一节时段中：直接切换到当前时段与阈值
          noiseService.setSession(current.name, sessionConfig.alertThresholdDb ?? 55)
          setSessionName(current.name)
        }
      } else if (monitoring && sessionName !== '自由监测') {
        stopNoise()
      }
    }
    evaluate()
    const timer = window.setInterval(evaluate, 30_000)
    return () => window.clearInterval(timer)
  }, [
    noiseEnabled,
    sessionConfig,
    monitoring,
    autoStart,
    micPermissionState,
    sessionName,
    startNoise,
    stopNoise,
  ])

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.()
      noiseService.stop()
    }
  }, [])

  const dbColor = (() => {
    if (!monitoring || status !== 'active' || typeof displayDb !== 'number') return 'grey'
    if (displayDb < 40) return 'success'
    if (displayDb < 55) return 'light-green'
    if (displayDb < 70) return 'warning'
    if (displayDb < 85) return 'orange'
    return 'error'
  })()

  const noiseStatusText = (() => {
    if (!monitoring || status !== 'active') return '未监测'
    if (displayDb < 30) return '极其安静'
    if (displayDb < 40) return '非常安静'
    if (displayDb < 50) return '安静'
    if (displayDb < 60) return '正常交谈'
    if (displayDb < 70) return '较为嘈杂'
    if (displayDb < 80) return '嘈杂'
    if (displayDb < 90) return '非常嘈杂'
    return '极度嘈杂'
  })()

  return (
    <>
      <article className="v-card border rounded-xl time-card" onClick={() => setOpen(true)}>
        <div className="v-card-text" style={{ padding: 24 }}>
          <div className="d-flex align-center" style={{ gap: 16 }}>
            <div className="flex-grow-1">
              <div
                className="time-display"
                style={{
                  fontSize: `min(${fontSize * 2}px, 11vw)`,
                  fontWeight: 700,
                  lineHeight: 1,
                  letterSpacing: 4,
                }}
              >
                {timeString}
                <span className="seconds-text" style={{ fontSize: `min(${fontSize * 0.9}px, 7vw)`, opacity: 0.6 }}>
                  :{pad(now.getSeconds())}
                </span>
                {use12h && (
                  <span className="ampm-text" style={{ fontSize: `min(${fontSize * 0.9}px, 7vw)`, opacity: 0.6, marginLeft: 6 }}>
                    {ampm}
                  </span>
                )}
              </div>
              <div className="date-line mt-3" style={{ fontSize: `min(${fontSize * 0.6}px, 4.8vw)`, letterSpacing: 1, opacity: 0.75 }}>
                {longDate(now)} {weekdayLabel(now)} {periodOfDay(now)}
              </div>
            </div>

            {noiseEnabled && (
              <div
                className="noise-side d-flex flex-column align-center justify-center"
                style={{ minWidth: 80 }}
                onClick={(event) => {
                  event.stopPropagation()
                  setDetailOpen(true)
                }}
              >
                {micPermissionState === 'denied' ? (
                  <>
                    <Icon name="microphoneOff" size={24} className="text-error" />
                    <div className="text-caption text-error mt-1" style={{ whiteSpace: 'nowrap', fontSize: 10 }}>
                      权限被拒绝
                    </div>
                  </>
                ) : micPermissionState === 'unavailable' ? (
                  <>
                    <Icon name="microphoneOff" size={24} className="text-warning" />
                    <div className="text-caption text-warning mt-1" style={{ whiteSpace: 'nowrap', fontSize: 10 }}>
                      无麦克风
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className={`noise-side-db font-weight-bold text-${dbColor}`}
                      style={{ fontSize: `min(${fontSize * 0.9}px, 7vw)`, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {monitoring && status === 'active' ? Math.round(displayDb) : '--'}
                    </div>
                    <div className={`text-caption mt-1 text-${dbColor}`} style={{ whiteSpace: 'nowrap', fontSize: 11 }}>
                      {noiseStatusText}
                    </div>
                    {!monitoring && (
                      <div className="text-caption text-medium-emphasis mt-1" style={{ fontSize: 10 }}>
                        点击开启
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </article>

      <NoiseMonitorDetail
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        status={status}
        currentDb={monitoring && status === 'active' ? Math.round(displayDb) : '--'}
        noiseLevel={monitoring && status === 'active' ? noiseStatusText : '等待监测'}
        dbColor={dbColor}
        currentScore={score}
        scoreDetail={scoreDetail}
        ringBuffer={ringBuffer}
        isMonitoring={monitoring}
        micPermissionState={micPermissionState}
        onStart={() => void startNoise()}
        onStop={stopNoise}
      />

      {/* 麦克风权限引导 */}
      <Modal
        open={permissionOpen}
        onClose={() => {
          setPermissionOpen(false)
        }}
        width={480}
        closable={false}
        footer={
          <>
            <button
              type="button"
              className="v-btn v-btn--variant-text"
              onClick={() => {
                settings.set('noiseMonitor.permissionDismissed', true)
                setPermissionOpen(false)
              }}
            >
              暂不开启
            </button>
            <div className="flex-grow-1" />
            <button
              type="button"
              className="v-btn v-btn--variant-flat"
              data-color="primary"
              onClick={async () => {
                setPermissionOpen(false)
                await startNoise()
                setMicPermissionState(await checkMicPermission())
              }}
            >
              <Icon name="microphone" size={18} />
              授权并开始
            </button>
          </>
        }
      >
        <div className="text-center" style={{ paddingTop: 16 }}>
          <span className="permission-avatar">
            <Icon name="microphone" size={36} />
          </span>
        </div>
        <div className="v-card-title text-h6 justify-center" style={{ paddingTop: 16 }}>
          开启环境噪音监测
        </div>
        <div className="text-body-2 text-medium-emphasis" style={{ padding: '0 8px' }}>
          <p className="mb-3">该功能可以实时监测教室环境噪音，帮助营造安静的学习氛围：</p>
          <div className="d-flex align-start mb-2">
            <Icon name="chartLine" size={18} className="text-primary mr-2 mt-1" />
            <span>实时显示环境分贝数与噪音等级评估</span>
          </div>
          <div className="d-flex align-start mb-2">
            <Icon name="clock" size={18} className="text-primary mr-2 mt-1" />
            <span>在晚自习时段自动记录并生成统计报告</span>
          </div>
          <div className="d-flex align-start mb-4">
            <Icon name="lock" size={18} className="text-primary mr-2 mt-1" />
            <span>音频数据仅在本地处理，不会上传或存储录音</span>
          </div>
          <div className="v-alert v-alert--variant-tonal" data-color="info" style={{ padding: 12 }}>
            需要授予麦克风权限才能使用此功能。浏览器将弹出权限请求，请点击「允许」。
          </div>

          <div className="d-flex align-center mt-4" style={{ padding: '8px 0' }}>
            <Icon name="microphone" size={20} className="mr-3 text-medium-emphasis" />
            <div className="flex-grow-1">
              <div className="text-body-2">启用噪音监测</div>
              <div className="text-caption text-medium-emphasis">关闭后将不再提醒</div>
            </div>
            <label className="v-switch">
              <input
                type="checkbox"
                checked={noiseEnabled}
                onChange={(event) => {
                  settings.set('noiseMonitor.enabled', event.target.checked)
                  if (!event.target.checked) {
                    settings.set('noiseMonitor.permissionDismissed', true)
                    setPermissionOpen(false)
                  }
                }}
              />
              <span className="v-switch__track">
                <span className="v-switch__thumb" />
              </span>
            </label>
          </div>
        </div>
      </Modal>

      <FullscreenClock open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/* ------------------------------------------------------------------ */

function FullscreenClock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const now = useNow(1000)
  const [use12h] = useSetting<boolean>('timeCard.use12h')
  const [mode, setMode] = useState<FullscreenMode>('clock')
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---- 倒计时 ---- */
  const [presetSeconds, setPresetSeconds] = useState(300)
  const [remaining, setRemaining] = useState(0)
  const [total, setTotal] = useState(0)
  const [countdownRunning, setCountdownRunning] = useState(false)
  const [countdownDone, setCountdownDone] = useState(false)
  const tickRef = useRef<number | null>(null)
  const lastTick = useRef(0)

  /* ---- 秒表 ---- */
  const [elapsed, setElapsed] = useState(0)
  const [stopwatchRunning, setStopwatchRunning] = useState(false)
  const [laps, setLaps] = useState<{ split: number; total: number }[]>([])
  const stopwatchRef = useRef<number | null>(null)
  const stopwatchLast = useRef(0)
  const lastLap = useRef(0)

  const showToolbar = useCallback(() => {
    setToolbarVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setToolbarVisible(false), 3200)
  }, [])

  useEffect(() => {
    if (open) showToolbar()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [open, showToolbar])

  useEffect(() => {
    if (!open) {
      setCountdownRunning(false)
      setStopwatchRunning(false)
      setMode('clock')
      setRemaining(0)
      setTotal(0)
      setCountdownDone(false)
      setElapsed(0)
      setLaps([])
      // 关闭后必须清掉计次基准，否则重开后的第一次计次会算出负值（F17）
      lastLap.current = 0
      stopwatchLast.current = 0
    }
  }, [open])

  /* 倒计时循环 */
  useEffect(() => {
    if (!countdownRunning) {
      if (tickRef.current) window.clearInterval(tickRef.current)
      tickRef.current = null
      return
    }
    lastTick.current = Date.now()
    tickRef.current = window.setInterval(() => {
      const current = Date.now()
      const delta = current - lastTick.current
      lastTick.current = current
      setRemaining((prev) => {
        const next = prev - delta
        if (next <= 0) {
          setCountdownRunning(false)
          setCountdownDone(true)
          beep(3)
          return 0
        }
        return next
      })
    }, 100)
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current)
    }
  }, [countdownRunning])

  /* 秒表循环 */
  useEffect(() => {
    if (!stopwatchRunning) {
      if (stopwatchRef.current) window.clearInterval(stopwatchRef.current)
      stopwatchRef.current = null
      return
    }
    stopwatchLast.current = Date.now()
    stopwatchRef.current = window.setInterval(() => {
      const current = Date.now()
      const delta = current - stopwatchLast.current
      stopwatchLast.current = current
      setElapsed((prev) => prev + delta)
    }, 50)
    return () => {
      if (stopwatchRef.current) window.clearInterval(stopwatchRef.current)
    }
  }, [stopwatchRunning])

  const hours = now.getHours()
  const timeString = `${pad(use12h ? hours % 12 || 12 : hours)}:${pad(now.getMinutes())}`

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={2000}
      closable={false}
      maskClosable={false}
      className="h-[100dvh] max-h-none rounded-none"
    >
      <div
        className="-mx-5 flex h-full min-h-[calc(100dvh-20px)] flex-col sm:-mx-6"
        onMouseMove={showToolbar}
        onTouchStart={showToolbar}
      >
        <div
          className="flex justify-center pt-5 transition-all duration-300"
          style={{ opacity: toolbarVisible ? 1 : 0, transform: toolbarVisible ? 'none' : 'translateY(-12px)' }}
        >
          <div
            className="flex gap-1 rounded-[14px] p-1"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
          >
            {(
              [
                { value: 'clock', label: '时钟', icon: 'clock' },
                { value: 'countdown', label: '倒计时', icon: 'timer' },
                { value: 'stopwatch', label: '秒表', icon: 'play' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setMode(tab.value)}
                className="flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-[13px] font-medium transition-colors"
                style={
                  mode === tab.value
                    ? { background: 'var(--primary)', color: 'var(--primary-ink)' }
                    : { color: 'var(--text-2)' }
                }
              >
                <Icon name={tab.icon} size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center px-6">
          {mode === 'clock' && (
            <>
              <div
                className="font-mono font-bold tabular-nums"
                style={{ fontSize: 'clamp(4rem, 15vw, 12rem)', lineHeight: 1, letterSpacing: '4px' }}
              >
                {timeString}
                <span className="ml-2 align-baseline opacity-45" style={{ fontSize: '0.42em' }}>
                  :{pad(now.getSeconds())}
                </span>
              </div>
              <div
                className="mt-6 text-center"
                style={{ fontSize: 'clamp(1rem, 2.6vw, 1.8rem)', color: 'var(--text-2)', letterSpacing: '2px' }}
              >
                {longDate(now)} {weekdayLabel(now)} {periodOfDay(now)}
              </div>
              <div className="mt-10 w-full max-w-[420px]">
                <div
                  className="mb-2 flex justify-between text-[12px]"
                  style={{ color: 'var(--text-3)' }}
                >
                  <span>今日已过</span>
                  <span className="tabular-nums">{dayProgress(now).toFixed(1)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${dayProgress(now)}%`, background: 'var(--primary)' }}
                  />
                </div>
              </div>
            </>
          )}

          {mode === 'countdown' && (
            <>
              {!countdownRunning && remaining <= 0 && !countdownDone ? (
                <div className="flex w-full max-w-[560px] flex-col items-center">
                  <div className="flex items-end gap-2">
                    {[
                      { value: Math.floor(presetSeconds / 3600), unit: '时' },
                      { value: Math.floor((presetSeconds % 3600) / 60), unit: '分' },
                      { value: presetSeconds % 60, unit: '秒' },
                    ].map((part, index) => (
                      <div key={part.unit} className="flex items-end gap-2">
                        <div className="text-center">
                          <div
                            className="font-mono font-bold tabular-nums"
                            style={{ fontSize: 'clamp(2.6rem, 7vw, 5rem)', lineHeight: 1 }}
                          >
                            {pad(part.value)}
                          </div>
                          <div className="mt-1 text-[12px]" style={{ color: 'var(--text-3)' }}>
                            {part.unit}
                          </div>
                        </div>
                        {index < 2 && (
                          <div
                            className="pb-6 font-mono"
                            style={{ fontSize: 'clamp(2rem, 5vw, 3.4rem)', opacity: 0.35 }}
                          >
                            :
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="mt-8 flex flex-wrap justify-center gap-2">
                    {COUNTDOWN_PRESETS.map((preset) => (
                      <button
                        key={preset.seconds}
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => setPresetSeconds(preset.seconds)}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="mt-8 flex items-center gap-2">
                    <button
                      type="button"
                      className="btn btn-outline btn-icon"
                      onClick={() => setPresetSeconds((s) => Math.max(60, s - 60))}
                      aria-label="减少一分钟"
                    >
                      <Icon name="minus" size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-lg px-8"
                      disabled={presetSeconds <= 0}
                      onClick={() => {
                        setTotal(presetSeconds * 1000)
                        setRemaining(presetSeconds * 1000)
                        setCountdownRunning(true)
                        setCountdownDone(false)
                      }}
                    >
                      <Icon name="play" size={15} />
                      开始
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-icon"
                      onClick={() => setPresetSeconds((s) => s + 60)}
                      aria-label="增加一分钟"
                    >
                      <Icon name="plus" size={16} />
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <div
                    className="font-mono font-bold tabular-nums transition-opacity"
                    style={{
                      fontSize: 'clamp(4rem, 15vw, 11rem)',
                      lineHeight: 1,
                      color: countdownDone ? 'var(--error)' : undefined,
                      animation: countdownDone ? 'pulse 1s ease-in-out infinite' : undefined,
                    }}
                  >
                    {formatCountdown(remaining)}
                  </div>
                  <div className="mt-3 text-[15px]" style={{ color: 'var(--text-2)' }}>
                    {countdownDone ? '时间到！' : countdownRunning ? '倒计时进行中' : '已暂停'}
                  </div>
                  <div className="mt-6 h-1.5 w-[min(80vw,420px)] overflow-hidden rounded-full" style={{ background: 'var(--surface-3)' }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${total > 0 ? ((total - remaining) / total) * 100 : 0}%`,
                        background: countdownDone ? 'var(--error)' : 'var(--primary)',
                      }}
                    />
                  </div>
                  <div className="mt-7 flex gap-3">
                    <button
                      type="button"
                      className="btn btn-tonal btn-lg btn-icon"
                      onClick={() => setCountdownRunning((r) => !r)}
                      aria-label={countdownRunning ? '暂停' : '继续'}
                    >
                      <Icon name={countdownRunning ? 'pause' : 'play'} size={20} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-lg btn-icon"
                      onClick={() => {
                        setCountdownRunning(false)
                        setRemaining(0)
                        setTotal(0)
                        setCountdownDone(false)
                      }}
                      aria-label="重置"
                    >
                      <Icon name="stop" size={18} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {mode === 'stopwatch' && (
            <div className="flex flex-col items-center">
              <div
                className="font-mono font-bold tabular-nums"
                style={{ fontSize: 'clamp(3.4rem, 13vw, 9.5rem)', lineHeight: 1 }}
              >
                {formatStopwatch(elapsed)}
              </div>
              <div className="mt-3 text-[15px]" style={{ color: 'var(--text-2)' }}>
                {stopwatchRunning ? '计时中' : elapsed > 0 ? '已暂停' : '秒表'}
              </div>
              <div className="mt-7 flex gap-3">
                <button
                  type="button"
                  className="btn btn-tonal btn-lg btn-icon"
                  onClick={() => setStopwatchRunning((r) => !r)}
                  aria-label={stopwatchRunning ? '暂停' : '开始'}
                >
                  <Icon name={stopwatchRunning ? 'pause' : 'play'} size={20} />
                </button>
                {stopwatchRunning && (
                  <button
                    type="button"
                    className="btn btn-outline btn-lg btn-icon"
                    onClick={() => {
                      setLaps((prev) => [
                        { split: elapsed - lastLap.current, total: elapsed },
                        ...prev,
                      ])
                      lastLap.current = elapsed
                    }}
                    aria-label="计次"
                  >
                    <Icon name="flag" size={18} />
                  </button>
                )}
                {!stopwatchRunning && elapsed > 0 && (
                  <button
                    type="button"
                    className="btn btn-danger btn-lg btn-icon"
                    onClick={() => {
                      setElapsed(0)
                      setLaps([])
                      lastLap.current = 0
                    }}
                    aria-label="重置"
                  >
                    <Icon name="stop" size={18} />
                  </button>
                )}
              </div>

              {laps.length > 0 && (
                <div className="mt-7 w-[min(90vw,380px)] overflow-y-auto" style={{ maxHeight: '26vh' }}>
                  <table className="w-full text-[13px] tabular-nums">
                    <thead style={{ color: 'var(--text-3)' }}>
                      <tr>
                        <th className="py-1 text-left font-medium">#</th>
                        <th className="py-1 text-right font-medium">计次</th>
                        <th className="py-1 text-right font-medium">总计</th>
                      </tr>
                    </thead>
                    <tbody>
                      {laps.map((lap, index) => (
                        <tr key={`${lap.total}-${index}`} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="py-1.5 text-left">{laps.length - index}</td>
                          <td className="py-1.5 text-right font-mono">{formatStopwatch(lap.split)}</td>
                          <td className="py-1.5 text-right font-mono">{formatStopwatch(lap.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pb-6 pr-6" style={{ opacity: toolbarVisible ? 1 : 0.25 }}>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="关闭全屏时钟"
          >
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>
    </Modal>
  )
}

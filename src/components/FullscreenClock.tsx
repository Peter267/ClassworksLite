import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { dayProgress, longDate, periodOfDay, weekdayLabel } from '../lib/date'
import { useNow, useSetting } from '../lib/hooks'
import { settings } from '../lib/settings'

type FullscreenMode = 'clock' | 'countdown' | 'stopwatch'

const pad = (n: number) => String(n).padStart(2, '0')

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

function formatCountdownTotal(ms: number) {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0) parts.push(`${m}分钟`)
  if (s > 0) parts.push(`${s}秒`)
  return parts.join('') || '0秒'
}

function formatOvertime(ms: number) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}小时${m}分${s}秒`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

const COUNTDOWN_PRESETS = [
  { label: '1 分钟', h: 0, m: 1, s: 0 },
  { label: '3 分钟', h: 0, m: 3, s: 0 },
  { label: '5 分钟', h: 0, m: 5, s: 0 },
  { label: '10 分钟', h: 0, m: 10, s: 0 },
  { label: '15 分钟', h: 0, m: 15, s: 0 },
  { label: '30 分钟', h: 0, m: 30, s: 0 },
  { label: '1 小时', h: 1, m: 0, s: 0 },
]

const TABS = [
  { value: 'clock', label: '时钟', icon: 'clock' },
  { value: 'countdown', label: '倒计时', icon: 'hourglass' },
  { value: 'stopwatch', label: '秒表', icon: 'timer' },
] as const

export function FullscreenClock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const now = useNow(1000)
  const [use12h] = useSetting<boolean>('timeCard.use12h')
  const [timeCardEnabled] = useSetting<boolean>('timeCard.enabled')
  const [pendingTimeCard, setPendingTimeCard] = useState<boolean | null>(null)
  const [mode, setMode] = useState<FullscreenMode>('clock')
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const hideTimer = useRef<number | null>(null)
  const tabListRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  /* ---- 倒计时 ---- */
  const [countdownHours, setCountdownHours] = useState(0)
  const [countdownMinutes, setCountdownMinutes] = useState(5)
  const [countdownSeconds, setCountdownSeconds] = useState(0)
  const [countdownRunning, setCountdownRunning] = useState(false)
  const [countdownRemaining, setCountdownRemaining] = useState(0)
  const [countdownTotal, setCountdownTotal] = useState(0)
  const [countdownEndedDialog, setCountdownEndedDialog] = useState(false)
  const [overtimeElapsed, setOvertimeElapsed] = useState(0)
  const countdownLastTick = useRef(0)
  const overtimeLastTick = useRef(0)
  const overtimeTimer = useRef<number | null>(null)

  /* ---- 秒表 ---- */
  const [stopwatchRunning, setStopwatchRunning] = useState(false)
  const [stopwatchElapsed, setStopwatchElapsed] = useState(0)
  const stopwatchLastTick = useRef(0)
  const lastLap = useRef(0)
  const [laps, setLaps] = useState<{ split: number; total: number }[]>([])

  const clearToolbarTimer = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = null
  }, [])

  const showToolbar = useCallback(() => {
    setToolbarVisible(true)
    clearToolbarTimer()
    hideTimer.current = window.setTimeout(() => setToolbarVisible(false), 3000)
  }, [clearToolbarTimer])

  useEffect(() => {
    if (open) {
      showToolbar()
      return clearToolbarTimer
    }
    clearToolbarTimer()
    setSettingsOpen(false)
  }, [open, showToolbar, clearToolbarTimer])

  /* ---- 倒计时计时：50ms，与上游一致 ---- */
  useEffect(() => {
    if (!countdownRunning) return
    countdownLastTick.current = Date.now()
    const timer = window.setInterval(() => {
      const current = Date.now()
      const delta = current - countdownLastTick.current
      countdownLastTick.current = current
      setCountdownRemaining((prev) => Math.max(0, prev - delta))
    }, 50)
    return () => window.clearInterval(timer)
  }, [countdownRunning])

  const dismissCountdownEnded = useCallback(() => {
    setCountdownEndedDialog(false)
    setOvertimeElapsed(0)
    if (overtimeTimer.current) {
      window.clearInterval(overtimeTimer.current)
      overtimeTimer.current = null
    }
  }, [])

  const showCountdownEnded = useCallback(() => {
    setCountdownEndedDialog(true)
    setOvertimeElapsed(0)
    overtimeLastTick.current = Date.now()
    if (overtimeTimer.current) window.clearInterval(overtimeTimer.current)
    overtimeTimer.current = window.setInterval(() => {
      const current = Date.now()
      const delta = current - overtimeLastTick.current
      overtimeLastTick.current = current
      setOvertimeElapsed((prev) => prev + delta)
    }, 200)
  }, [])

  useEffect(() => {
    if (!countdownRunning || countdownRemaining > 0) return
    setCountdownRunning(false)
    beep(3)
    showCountdownEnded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdownRunning, countdownRemaining])

  /* ---- 秒表计时：30ms，与上游一致 ---- */
  useEffect(() => {
    if (!stopwatchRunning) return
    stopwatchLastTick.current = Date.now()
    const timer = window.setInterval(() => {
      const current = Date.now()
      const delta = current - stopwatchLastTick.current
      stopwatchLastTick.current = current
      setStopwatchElapsed((prev) => prev + delta)
    }, 30)
    return () => window.clearInterval(timer)
  }, [stopwatchRunning])

  useEffect(
    () => () => {
      clearToolbarTimer()
      if (overtimeTimer.current) window.clearInterval(overtimeTimer.current)
    },
    [clearToolbarTimer],
  )

  /* ---- 顶部 Tab 指示条 ---- */
  useEffect(() => {
    const update = () => {
      const active = tabListRef.current?.querySelector<HTMLElement>('.v-tab--active')
      if (!active) return
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth })
    }
    update()
    const observer = new ResizeObserver(update)
    if (tabListRef.current) observer.observe(tabListRef.current)
    return () => observer.disconnect()
  }, [mode, toolbarVisible])

  /* ---- Escape：只关闭内层弹窗，不关闭全屏 ---- */
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (settingsOpen) setSettingsOpen(false)
      else if (countdownEndedDialog) dismissCountdownEnded()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, settingsOpen, countdownEndedDialog, dismissCountdownEnded])

  const closeFullscreen = () => {
    const next = pendingTimeCard
    onClose()
    if (next !== null && next !== settings.get<boolean>('timeCard.enabled')) {
      // 与上游「刷新后生效」一致：让关闭动画先播完，再收起卡片
      window.setTimeout(() => settings.set('timeCard.enabled', next), 400)
    }
    setPendingTimeCard(null)
  }

  /* ---- 时钟 ---- */
  const hours = now.getHours()
  const displayHour = use12h ? hours % 12 || 12 : hours
  const timeString = `${pad(displayHour)}:${pad(now.getMinutes())}`
  const ampm = hours < 12 ? 'AM' : 'PM'
  const progress = dayProgress(now)

  /* ---- 倒计时 ---- */
  const countdownSetSeconds = countdownHours * 3600 + countdownMinutes * 60 + countdownSeconds
  const countdownProgress =
    countdownTotal > 0 ? ((countdownTotal - countdownRemaining) / countdownTotal) * 100 : 0

  const startCountdown = () => {
    const total = countdownSetSeconds * 1000
    if (total <= 0) return
    setCountdownTotal(total)
    setCountdownRemaining(total)
    setCountdownRunning(true)
    dismissCountdownEnded()
  }

  const toggleCountdown = () => {
    setCountdownRunning((running) => !running)
  }

  const resetCountdown = () => {
    setCountdownRunning(false)
    setCountdownRemaining(0)
    setCountdownTotal(0)
    dismissCountdownEnded()
  }

  const applyCountdownPreset = (preset: (typeof COUNTDOWN_PRESETS)[number]) => {
    setCountdownHours(preset.h)
    setCountdownMinutes(preset.m)
    setCountdownSeconds(preset.s)
  }

  /* ---- 秒表 ---- */
  const toggleStopwatch = () => setStopwatchRunning((running) => !running)

  const addLap = () => {
    const split = stopwatchElapsed - lastLap.current
    setLaps((current) => [{ split, total: stopwatchElapsed }, ...current])
    lastLap.current = stopwatchElapsed
  }

  const resetStopwatch = () => {
    setStopwatchRunning(false)
    setStopwatchElapsed(0)
    lastLap.current = 0
    setLaps([])
  }

  return (
    <>
      <Modal
        open={open}
        onClose={closeFullscreen}
        width={2000}
        fullscreen
        scrim={false}
        bare
        closable={false}
        maskClosable={false}
        transition="bottom"
      >
        <div className="fullscreen-time-card" onMouseMove={showToolbar} onTouchStart={showToolbar}>
          <div
            className="fullscreen-toolbar"
            style={{
              opacity: toolbarVisible ? 1 : 0,
              transform: toolbarVisible ? 'none' : 'translateY(-20px)',
              transition: 'opacity 0.4s ease, transform 0.4s ease',
              pointerEvents: toolbarVisible ? 'auto' : 'none',
            }}
          >
            <div className="fullscreen-tabs" ref={tabListRef}>
              {TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={`v-tab ${mode === tab.value ? 'v-tab--active' : ''}`}
                  onClick={() => setMode(tab.value)}
                >
                  <Icon name={tab.icon} size={18} />
                  {tab.label}
                </button>
              ))}
              <span
                className="v-tab-indicator"
                style={{
                  left: indicator.left,
                  width: indicator.width,
                  transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.3s',
                }}
              />
            </div>
          </div>

          <div className="fullscreen-time-body">
            {mode === 'clock' && (
              <div className="d-flex flex-column align-center justify-center">
                <div className="fullscreen-time-display">
                  {timeString}
                  <span className="fullscreen-seconds">:{pad(now.getSeconds())}</span>
                  {use12h && <span className="fullscreen-seconds"> {ampm}</span>}
                </div>
                <div className="fullscreen-date-line mt-6">
                  {longDate(now)} {weekdayLabel(now)} {periodOfDay(now)}
                </div>
                <div className="fullscreen-progress mt-10">
                  <div className="text-caption text-medium-emphasis mb-1">
                    今日已过 {progress.toFixed(1)}%
                  </div>
                  <div
                    className="v-progress-linear"
                    style={{ height: 6, borderRadius: 3, maxWidth: 400, width: '80vw' }}
                  >
                    <div
                      className="v-progress-linear__bar"
                      style={{ width: `${progress}%`, background: 'rgb(var(--v-theme-primary))' }}
                    />
                  </div>
                </div>
                <div className="fullscreen-extra mt-8 text-medium-emphasis d-flex" style={{ gap: 32 }} />
              </div>
            )}

            {mode === 'countdown' && (
              <>
                {!countdownRunning && countdownRemaining <= 0 ? (
                  <div className="d-flex flex-column align-center">
                    <div className="countdown-setup d-flex align-center" style={{ gap: 16 }}>
                      {[
                        {
                          value: countdownHours,
                          unit: '时',
                          max: 99,
                          set: setCountdownHours,
                        },
                        {
                          value: countdownMinutes,
                          unit: '分',
                          max: 59,
                          set: setCountdownMinutes,
                        },
                        {
                          value: countdownSeconds,
                          unit: '秒',
                          max: 59,
                          set: setCountdownSeconds,
                        },
                      ].map((part, index) => (
                        <div className="d-flex align-center" style={{ gap: 16 }} key={part.unit}>
                          <div className="text-center">
                            <button
                              type="button"
                              className="v-btn v-btn--icon v-btn--variant-text v-btn--size-small"
                              onClick={() =>
                                part.set((value) => Math.min(part.max, value + 1))
                              }
                              aria-label={`增加${part.unit}`}
                            >
                              <Icon name="up" size={20} />
                            </button>
                            <div className="countdown-digit">{pad(part.value)}</div>
                            <button
                              type="button"
                              className="v-btn v-btn--icon v-btn--variant-text v-btn--size-small"
                              onClick={() => part.set((value) => Math.max(0, value - 1))}
                              aria-label={`减少${part.unit}`}
                            >
                              <Icon name="down" size={20} />
                            </button>
                            <div className="text-caption text-medium-emphasis">{part.unit}</div>
                          </div>
                          {index < 2 && <div className="countdown-sep">:</div>}
                        </div>
                      ))}
                    </div>

                    <div className="mt-8 d-flex flex-wrap justify-center" style={{ gap: 12 }}>
                      {COUNTDOWN_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className="v-btn v-btn--variant-tonal rounded-xl"
                          onClick={() => applyCountdownPreset(preset)}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>

                    <div className="mt-8">
                      <button
                        type="button"
                        className="v-btn v-btn--size-x-large v-btn--variant-elevated rounded-xl"
                        data-color="primary"
                        disabled={countdownSetSeconds <= 0}
                        onClick={startCountdown}
                      >
                        <Icon name="play" size={18} />
                        开始
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="d-flex flex-column align-center">
                    <div
                      className={`fullscreen-time-display ${
                        countdownRemaining <= 0 && !countdownRunning ? 'countdown-ended' : ''
                      }`}
                    >
                      {formatCountdown(countdownRemaining)}
                    </div>
                    <div className="fullscreen-date-line mt-4 text-medium-emphasis">
                      {countdownRunning
                        ? '倒计时进行中'
                        : countdownRemaining <= 0
                          ? '时间到！'
                          : '已暂停'}
                    </div>
                    <div
                      className="v-progress-linear mt-8"
                      style={{ height: 6, borderRadius: 3, maxWidth: 400, width: '80vw' }}
                    >
                      <div
                        className="v-progress-linear__bar"
                        style={{
                          width: `${countdownProgress}%`,
                          background:
                            countdownRemaining <= 0
                              ? 'rgb(var(--v-theme-error))'
                              : 'rgb(var(--v-theme-primary))',
                        }}
                      />
                    </div>
                    <div className="mt-8 d-flex" style={{ gap: 12 }}>
                      {countdownRemaining > 0 && (
                        <button
                          type="button"
                          className="v-btn v-btn--size-x-large v-btn--variant-tonal v-btn--icon"
                          data-color={countdownRunning ? 'warning' : 'primary'}
                          onClick={toggleCountdown}
                          aria-label={countdownRunning ? '暂停' : '继续'}
                        >
                          <Icon name={countdownRunning ? 'pause' : 'play'} size={20} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="v-btn v-btn--size-x-large v-btn--variant-tonal v-btn--icon"
                        data-color="error"
                        onClick={resetCountdown}
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
              <div className="d-flex flex-column align-center">
                <div className="fullscreen-time-display">{formatStopwatch(stopwatchElapsed)}</div>
                <div className="fullscreen-date-line mt-4 text-medium-emphasis">
                  {stopwatchRunning ? '计时中' : stopwatchElapsed > 0 ? '已暂停' : '秒表'}
                </div>
                <div className="mt-8 d-flex" style={{ gap: 12 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--size-x-large v-btn--variant-tonal v-btn--icon"
                    data-color={stopwatchRunning ? 'warning' : 'primary'}
                    onClick={toggleStopwatch}
                    aria-label={stopwatchRunning ? '暂停' : '开始'}
                  >
                    <Icon name={stopwatchRunning ? 'pause' : 'play'} size={20} />
                  </button>
                  {stopwatchRunning && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-x-large v-btn--variant-tonal v-btn--icon"
                      data-color="info"
                      onClick={addLap}
                      aria-label="计次"
                    >
                      <Icon name="flag" size={18} />
                    </button>
                  )}
                  {!stopwatchRunning && stopwatchElapsed > 0 && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-x-large v-btn--variant-tonal v-btn--icon"
                      data-color="error"
                      onClick={resetStopwatch}
                      aria-label="重置"
                    >
                      <Icon name="stop" size={18} />
                    </button>
                  )}
                </div>

                {laps.length > 0 && (
                  <div className="stopwatch-laps mt-6 slide-y-enter">
                    <table className="stopwatch-laps-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>计次</th>
                          <th>总计</th>
                        </tr>
                      </thead>
                      <tbody>
                        {laps.map((lap, index) => (
                          <tr key={`${lap.total}-${index}`}>
                            <td>{laps.length - index}</td>
                            <td>{formatStopwatch(lap.split)}</td>
                            <td>{formatStopwatch(lap.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="fullscreen-actions">
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text v-btn--size-large"
              onClick={() => setSettingsOpen(true)}
              aria-label="时间卡片设置"
            >
              <Icon name="settings" size={24} />
            </button>
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text v-btn--size-large"
              onClick={closeFullscreen}
              aria-label="关闭全屏时钟"
            >
              <Icon name="close" size={24} />
            </button>
          </div>
        </div>
      </Modal>

      {/* 时间卡片设置（对齐上游 TimeCard.vue） */}
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        width={420}
        className="rounded-xl"
        closable={false}
        title={
          <span className="d-flex align-center">
            <Icon name="settings" size={24} className="mr-2" />
            时间卡片设置
          </span>
        }
        footer={
          <>
            <div className="flex-grow-1" />
            <button
              type="button"
              className="v-btn v-btn--variant-text"
              onClick={() => setSettingsOpen(false)}
            >
              完成
            </button>
          </>
        }
      >
        <div className="v-list" style={{ padding: 0 }}>
          <div
            className="v-list-item d-flex align-center"
            style={{ padding: '10px 0', gap: 12, cursor: 'default' }}
          >
            <Icon name="clock" size={24} className="text-medium-emphasis" />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div className="v-list-item-title">显示时间卡片</div>
              <div className="v-list-item-subtitle" style={{ whiteSpace: 'normal' }}>
                在首页显示时间卡片，刷新后生效。
              </div>
            </div>
            <label className="v-switch">
              <input
                type="checkbox"
                checked={pendingTimeCard ?? timeCardEnabled}
                onChange={(event) => {
                  const checked = event.target.checked
                  setPendingTimeCard(checked)
                  if (checked) settings.set('timeCard.enabled', true)
                }}
              />
              <span className="v-switch__track">
                <span className="v-switch__thumb" />
              </span>
            </label>
          </div>

          <div
            className="v-list-item d-flex align-center"
            style={{ padding: '10px 0', gap: 12, cursor: 'default' }}
          >
            <Icon name="timer" size={24} className="text-medium-emphasis" />
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div className="v-list-item-title">12 小时制</div>
              <div className="v-list-item-subtitle" style={{ whiteSpace: 'normal' }}>
                以 12 小时制（AM/PM）显示时间。
              </div>
            </div>
            <label className="v-switch">
              <input
                type="checkbox"
                checked={use12h}
                onChange={(event) => settings.set('timeCard.use12h', event.target.checked)}
              />
              <span className="v-switch__track">
                <span className="v-switch__thumb" />
              </span>
            </label>
          </div>
        </div>
      </Modal>

      {/* 倒计时结束（对齐上游 TimeCard.vue） */}
      <Modal
        open={countdownEndedDialog}
        onClose={dismissCountdownEnded}
        width={480}
        className="rounded-xl"
        closable={false}
        maskClosable={false}
        footer={
          <div className="d-flex justify-center w-full">
            <button
              type="button"
              className="v-btn v-btn--size-large v-btn--variant-tonal rounded-xl"
              data-color="primary"
              onClick={dismissCountdownEnded}
            >
              <Icon name="check" size={18} />
              知道了
            </button>
          </div>
        }
      >
        <div className="text-center" style={{ paddingTop: 8 }}>
          <div className="d-flex align-center justify-center" style={{ paddingTop: 16 }}>
            <Icon name="alarm" size={32} className="text-error mr-2" />
            <span className="text-h6">时间到！</span>
          </div>
          <div
            className="text-h4 font-weight-bold"
            style={{ margin: '16px 0', fontVariantNumeric: 'tabular-nums' }}
          >
            {formatCountdownTotal(countdownTotal)}
          </div>
          <div className="text-body-1 text-medium-emphasis">设定的倒计时已结束</div>
          {overtimeElapsed > 0 && (
            <div className="mt-4">
              <span
                className="v-chip v-chip--variant-tonal"
                data-color="error"
                style={{ height: 40, padding: '0 16px', fontSize: '0.875rem' }}
              >
                <Icon name="clockAlert" size={18} className="mr-2" />
                已超时 {formatOvertime(overtimeElapsed)}
              </span>
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}

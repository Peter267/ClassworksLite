import { useCallback, useEffect, useState } from 'react'
import { FullscreenClock } from './FullscreenClock'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { NoiseMonitorDetail } from './NoiseMonitorDetail'
import { longDate, periodOfDay, weekdayLabel } from '../lib/date'
import { useNow, useSetting } from '../lib/hooks'
import { getClient } from '../lib/kv'
import {
  noiseService,
  type MicPermissionState,
  type NoiseScoreDetail,
  type NoiseSessionConfig,
  type NoiseSlice,
  type NoiseStatus,
} from '../lib/noise'
import { settings } from '../lib/settings'

const pad = (n: number) => String(n).padStart(2, '0')

const DEFAULT_SESSIONS: NoiseSessionConfig['sessions'] = [
  { name: '第1节晚自习', start: '19:20', duration: 60, enabled: true },
  { name: '第2节晚自习', start: '20:20', duration: 110, enabled: true },
]

async function checkMicPermission(): Promise<MicPermissionState> {
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!devices.some((device) => device.kind === 'audioinput')) return 'unavailable'
    }
    if (!navigator.permissions?.query) {
      // Safari/部分浏览器不支持查询麦克风权限，用上次成功授权的结果兜底
      return settings.get<boolean>('noiseMonitor.micGranted') ? 'granted' : 'prompt'
    }
    const result = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return result.state as MicPermissionState
  } catch {
    return settings.get<boolean>('noiseMonitor.micGranted') ? 'granted' : 'prompt'
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
  const [status, setStatus] = useState<NoiseStatus>(() => noiseService.getStatus())
  const [displayDb, setDisplayDb] = useState(0)
  const [ringBuffer, setRingBuffer] = useState<NoiseSlice[]>([])
  const [score, setScore] = useState<number | null>(null)
  const [scoreDetail, setScoreDetail] = useState<NoiseScoreDetail | null>(null)
  const [sessionConfig, setSessionConfig] = useState<NoiseSessionConfig | null>(null)
  const monitoring = status === 'active'

  const hours = now.getHours()
  const displayHour = use12h ? hours % 12 || 12 : hours
  const timeString = `${pad(displayHour)}:${pad(now.getMinutes())}`
  const ampm = hours < 12 ? 'AM' : 'PM'

  const stopNoise = useCallback(() => {
    noiseService.stop({ manual: true })
  }, [])

  const startNoise = useCallback(async () => {
    try {
      await noiseService.startCurrent()
    } catch {
      if (noiseService.getStatus() === 'permission-denied') {
        settings.set('noiseMonitor.micGranted', false)
        setMicPermissionState('denied')
      }
    } finally {
      const permission = await checkMicPermission()
      const effective =
        permission === 'prompt' && noiseService.getStatus() === 'active'
          ? 'granted'
          : permission
      setMicPermissionState(effective)
      if (effective === 'granted' && noiseService.getStatus() === 'active') {
        settings.set('noiseMonitor.micGranted', true)
      } else if (effective === 'denied' || effective === 'unavailable') {
        settings.set('noiseMonitor.micGranted', false)
      }
    }
  }, [])

  /* 服务层单例订阅：组件卸载不停止监测，路由切换后回来仍是同一会话 */
  useEffect(() => {
    return noiseService.subscribe((snapshot) => {
      setStatus(snapshot.status)
      setDisplayDb((previous) => {
        if (snapshot.status !== 'active') return 0
        return previous === 0
          ? snapshot.currentDisplayDb
          : previous * 0.75 + snapshot.currentDisplayDb * 0.25
      })
      setRingBuffer(snapshot.ringBuffer)
      setScore(snapshot.currentScore)
      setScoreDetail(snapshot.currentScoreDetail)
    })
  }, [])

  /* 加载晚自习配置（KV） */
  useEffect(() => {
    if (!noiseEnabled) {
      noiseService.setSchedule(null)
      noiseService.stop()
      setSessionConfig(null)
      return
    }
    void (async () => {
      try {
        const entry = await getClient().get<NoiseSessionConfig>('noise-session-config')
        setSessionConfig(entry?.value ?? { sessions: DEFAULT_SESSIONS, alertThresholdDb: 55 })
      } catch (error) {
        console.warn('[noise] 时段配置读取失败，保留上次配置/暂停自动开始', error)
        setSessionConfig(null)
      }
    })()
  }, [noiseEnabled])

  /* 麦克风权限探测 */
  useEffect(() => {
    if (!noiseEnabled) return
    let cancelled = false
    void (async () => {
      const state = await checkMicPermission()
      if (cancelled) return
      setMicPermissionState(state)
      if (state === 'granted') settings.set('noiseMonitor.micGranted', true)
      if (state === 'denied' || state === 'unavailable') {
        settings.set('noiseMonitor.micGranted', false)
      }
      if (state === 'prompt' && !permissionDismissed) {
        setPermissionOpen(true)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseEnabled])

  /* 把时段、自动开始与权限状态交给服务层，由服务层跨路由维护 */
  useEffect(() => {
    if (!noiseEnabled || !sessionConfig) return
    noiseService.setSchedule({
      sessions: sessionConfig.sessions,
      alertThresholdDb: sessionConfig.alertThresholdDb,
      autoStart,
      permission: micPermissionState,
    })
  }, [noiseEnabled, sessionConfig, autoStart, micPermissionState])

  const dbColor = (() => {
    const db = monitoring && status === 'active' ? displayDb : 0
    if (db < 40) return 'success'
    if (db < 55) return 'light-green'
    if (db < 70) return 'warning'
    if (db < 85) return 'orange'
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
                    <div className="text-caption text-error mt-1" style={{ whiteSpace: 'nowrap' }}>
                      权限被拒绝
                    </div>
                  </>
                ) : micPermissionState === 'unavailable' ? (
                  <>
                    <Icon name="microphoneOff" size={24} className="text-warning" />
                    <div className="text-caption text-warning mt-1" style={{ whiteSpace: 'nowrap' }}>
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
                    <div className={`text-caption mt-1 text-${dbColor}`} style={{ whiteSpace: 'nowrap' }}>
                      {noiseStatusText}
                    </div>
                    {!monitoring && (
                      <div className="text-caption text-medium-emphasis mt-1" style={{ cursor: 'pointer' }}>
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


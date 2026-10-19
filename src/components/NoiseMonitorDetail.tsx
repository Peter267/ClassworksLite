import { useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import {
  clearReports,
  getNoiseControlSettings,
  getReportMeta,
  getReportsByDate,
  noiseService,
  resetNoiseControlSettings,
  saveNoiseControlSettings,
  type NoiseReport,
  type NoiseScoreDetail,
  type NoiseSlice,
  type NoiseStatus,
} from '../lib/noise'

export type MicPermissionState = 'granted' | 'prompt' | 'denied' | 'unavailable' | ''

interface NoiseMonitorDetailProps {
  open: boolean
  onClose: () => void
  status: NoiseStatus
  currentDb: number | string
  noiseLevel: string
  dbColor: string
  currentScore: number | null
  scoreDetail: NoiseScoreDetail | null
  ringBuffer: NoiseSlice[]
  isMonitoring: boolean
  micPermissionState: MicPermissionState
  onStart: () => void
  onStop: () => void
}

function dbToY(db: number, height = 120) {
  return height - (Math.max(0, Math.min(100, db)) / 100) * height
}

function formatTime(ts: number) {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatFullTime(ts: number) {
  if (!ts) return '--'
  const d = new Date(ts)
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(
    2,
    '0',
  )}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function formatDateLabel(dateStr: string) {
  if (!dateStr) return ''
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(
    2,
    '0',
  )}-${String(yesterday.getDate()).padStart(2, '0')}`
  if (dateStr === key) return '今天'
  if (dateStr === yKey) return '昨天'
  const [, month, day] = dateStr.split('-')
  return `${parseInt(month, 10)}月${parseInt(day, 10)}日`
}

function formatDuration(ms: number) {
  if (!ms) return '0 分钟'
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h} 小时 ${m} 分钟`
  return `${m} 分钟`
}

function formatSeconds(sec: number) {
  if (!sec || sec < 0) return '0秒'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

function scoreColor(score: number | null) {
  if (score === null) return 'grey'
  if (score >= 80) return 'success'
  if (score >= 60) return 'warning'
  return 'error'
}

function scoreLabel(score: number | null) {
  if (score === null) return '暂无评分'
  if (score >= 90) return '非常安静'
  if (score >= 80) return '环境良好'
  if (score >= 60) return '需要注意'
  if (score >= 40) return '比较嘈杂'
  return '极度嘈杂'
}

function reportScoreLabel(score: number) {
  if (score >= 90) return '优秀'
  if (score >= 80) return '良好'
  if (score >= 60) return '一般'
  if (score >= 40) return '较差'
  return '极差'
}

function levelDistribution(report: NoiseReport | null) {
  const base = [
    { label: '安静', percent: 0, color: '#4caf50' },
    { label: '正常', percent: 0, color: '#8bc34a' },
    { label: '吵闹', percent: 0, color: '#ff9800' },
    { label: '极吵', percent: 0, color: '#f44336' },
  ]
  if (!report?.samples?.length) return base
  let quiet = 0
  let normal = 0
  let loud = 0
  let extreme = 0
  for (const sample of report.samples) {
    if (sample.db < 45) quiet += 1
    else if (sample.db < 60) normal += 1
    else if (sample.db < 75) loud += 1
    else extreme += 1
  }
  const total = report.samples.length
  return [
    { label: '安静', percent: Math.round((quiet / total) * 100), color: '#4caf50' },
    { label: '正常', percent: Math.round((normal / total) * 100), color: '#8bc34a' },
    { label: '吵闹', percent: Math.round((loud / total) * 100), color: '#ff9800' },
    { label: '极吵', percent: Math.round((extreme / total) * 100), color: '#f44336' },
  ]
}

export function NoiseMonitorDetail({
  open,
  onClose,
  status,
  currentDb,
  noiseLevel,
  dbColor,
  currentScore,
  scoreDetail,
  ringBuffer,
  isMonitoring,
  micPermissionState,
  onStart,
  onStop,
}: NoiseMonitorDetailProps) {
  const [tab, setTab] = useState<'realtime' | 'reports'>('realtime')
  const [reportVersion, setReportVersion] = useState(0)
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [selectedReportIndex, setSelectedReportIndex] = useState(0)
  const [calibrateOpen, setCalibrateOpen] = useState(false)
  const [calibrateTarget, setCalibrateTarget] = useState(40)
  const [calibrating, setCalibrating] = useState(false)
  const [calibrateMessage, setCalibrateMessage] = useState('')
  const [calibrateSuccess, setCalibrateSuccess] = useState(false)
  const [calibration, setCalibration] = useState(getNoiseControlSettings())
  const [editBaselineDb, setEditBaselineDb] = useState(40)
  const [editBaselineRms, setEditBaselineRms] = useState('')
  const [editMaxLevelDb, setEditMaxLevelDb] = useState(100)
  const [confirmClear, setConfirmClear] = useState<'' | 'date' | 'all'>('')

  useEffect(() => {
    if (!open) return
    setReportVersion((v) => v + 1)
  }, [open])

  const meta = useMemo(() => {
    void reportVersion
    return getReportMeta()
  }, [reportVersion, tab, isMonitoring])

  const dateKeys = useMemo(() => Object.keys(meta.dates).sort().reverse(), [meta])
  const dateReports = useMemo(() => {
    void reportVersion
    return getReportsByDate(selectedDate)
  }, [selectedDate, reportVersion])
  const selectedReport = dateReports[selectedReportIndex] ?? null

  useEffect(() => {
    setSelectedReportIndex(0)
  }, [selectedDate])

  const waveWidth = 600
  const wavePath = useMemo(() => {
    if (ringBuffer.length < 2) return null
    const points = ringBuffer.slice(-120)
    const step = waveWidth / (points.length - 1)
    return points
      .map((point, index) => {
        const x = index * step
        const y = dbToY(point.displayDb ?? 0)
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [ringBuffer])

  const penaltyItems = scoreDetail
    ? [
        { label: '持续', icon: 'volume' as const, color: 'amber', percent: Math.round((scoreDetail.sustainedPenalty / 100) * 100) },
        { label: '时长', icon: 'clockAlert' as const, color: 'orange', percent: Math.round((scoreDetail.timePenalty / 100) * 100) },
        { label: '打断', icon: 'flashAlert' as const, color: 'pink', percent: Math.round((scoreDetail.segmentPenalty / 100) * 100) },
      ]
    : []

  const openCalibrate = () => {
    const current = getNoiseControlSettings()
    setCalibration(current)
    setEditBaselineDb(current.baselineDb)
    setEditBaselineRms(current.baselineRms != null ? String(current.baselineRms) : '')
    setEditMaxLevelDb(current.maxLevelDb)
    setCalibrateMessage('')
    setCalibrateOpen(true)
  }

  const doAutoCalibrate = () => {
    setCalibrating(true)
    setCalibrateMessage('')
    noiseService.calibrate(calibrateTarget, (success, message) => {
      setCalibrating(false)
      setCalibrateSuccess(success)
      setCalibrateMessage(message)
      if (success) setCalibration(getNoiseControlSettings())
      window.setTimeout(() => setCalibrateMessage(''), 5000)
    })
  }

  const reportWavePath = useMemo(() => {
    if (!selectedReport?.samples?.length || selectedReport.samples.length < 2) return null
    const step = waveWidth / (selectedReport.samples.length - 1)
    return selectedReport.samples
      .map((sample, index) => {
        const x = index * step
        const y = dbToY(sample.db, 140)
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }, [selectedReport])

  return (
    <Modal open={open} onClose={onClose} width={900} bare closable={false}>
      <div className="v-card-title" style={{ padding: '16px', gap: 8 }}>
        <Icon name="waveform" size={22} className="text-primary mr-2" />
        <span className="text-h6 font-weight-bold">环境噪音监测</span>
        <div className="flex-grow-1" />
        <span
          className="v-chip v-chip--size-small v-chip--variant-tonal"
          data-color={isMonitoring ? 'success' : undefined}
        >
          {isMonitoring
            ? '监测中'
            : status === 'permission-denied'
              ? '无权限'
              : status === 'error'
                ? '错误'
                : '已停止'}
        </span>
        <button type="button" className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div className="v-tabs v-tabs--grow">
        <button
          type="button"
          className={`v-tab ${tab === 'realtime' ? 'v-tab--active' : ''}`}
          onClick={() => setTab('realtime')}
        >
          <Icon name="waveform" size={18} />
          实时监测
        </button>
        <button
          type="button"
          className={`v-tab ${tab === 'reports' ? 'v-tab--active' : ''}`}
          onClick={() => setTab('reports')}
        >
          <Icon name="chartBar" size={18} />
          统计报告
        </button>
      </div>

      <div style={{ overflowY: 'auto', maxHeight: '70vh' }}>
        {tab === 'realtime' ? (
          <>
            {micPermissionState === 'denied' && (
              <div className="v-alert v-alert--variant-tonal" data-color="error" style={{ margin: 16 }}>
                <Icon name="microphoneOff" size={28} />
                <div>
                  <div className="text-subtitle-2 font-weight-bold mb-1">麦克风权限被拒绝</div>
                  <div className="text-body-2">
                    浏览器已拒绝麦克风访问，无法进行噪音监测。请在浏览器地址栏左侧的锁图标中重新授予麦克风权限，然后刷新页面。
                  </div>
                </div>
              </div>
            )}
            {micPermissionState === 'unavailable' && (
              <div className="v-alert v-alert--variant-tonal" data-color="warning" style={{ margin: 16 }}>
                <Icon name="microphoneOff" size={28} />
                <div>
                  <div className="text-subtitle-2 font-weight-bold mb-1">未检测到麦克风</div>
                  <div className="text-body-2">
                    当前设备未检测到麦克风硬件，无法进行噪音监测。请连接麦克风后刷新页面重试。
                  </div>
                </div>
              </div>
            )}

            <div className="noise-dashboard" style={{ padding: 20 }}>
              <div className="d-flex justify-center align-center">
                <div className="text-center">
                  <div className={`noise-gauge-ring ring-${dbColor}`}>
                    <div className="noise-gauge-inner d-flex flex-column align-center justify-center">
                      <span className={`noise-gauge-value font-weight-bold text-${dbColor}`}>{currentDb}</span>
                      <span className="text-caption text-medium-emphasis">dB</span>
                    </div>
                  </div>
                  <div className={`text-subtitle-1 font-weight-medium mt-3 text-${dbColor}`}>{noiseLevel}</div>
                </div>
              </div>

              <div className="noise-level-bar mt-5 mx-auto" style={{ maxWidth: 500 }}>
                <div className="d-flex justify-space-between text-caption text-medium-emphasis mb-1">
                  <span>0 dB</span>
                  <span>50</span>
                  <span>100 dB</span>
                </div>
                <div className="noise-gradient-bar">
                  {isMonitoring && typeof currentDb === 'number' && (
                    <div
                      className="noise-indicator"
                      style={{ left: `${Math.min(100, Math.max(0, currentDb))}%` }}
                    />
                  )}
                </div>
              </div>
            </div>

            <hr className="v-divider" />

            <div style={{ padding: 20 }}>
              <div className="d-flex align-center mb-3">
                <Icon name="chartLine" size={18} className="text-primary mr-2" />
                <span className="text-subtitle-2 font-weight-medium">噪音走势</span>
                <div className="flex-grow-1" />
                <span className="text-caption text-medium-emphasis">
                  最近 {ringBuffer.length} 个采样
                </span>
              </div>
              <div className="noise-waveform">
                <svg width="100%" height="120" viewBox={`0 0 ${waveWidth} 120`} preserveAspectRatio="none">
                  {[20, 40, 60, 80].map((value) => (
                    <line
                      key={value}
                      x1="0"
                      y1={dbToY(value)}
                      x2={waveWidth}
                      y2={dbToY(value)}
                      stroke="currentColor"
                      strokeOpacity="0.08"
                      strokeDasharray="4,4"
                    />
                  ))}
                  <line
                    x1="0"
                    y1={dbToY(55)}
                    x2={waveWidth}
                    y2={dbToY(55)}
                    stroke="rgb(var(--v-theme-error))"
                    strokeOpacity="0.5"
                    strokeDasharray="6,3"
                    strokeWidth="1.5"
                  />
                  {wavePath && (
                    <path d={`${wavePath} L${waveWidth},120 L0,120 Z`} fill="url(#waveGradient-rt)" opacity="0.3" />
                  )}
                  {wavePath && (
                    <path
                      d={wavePath}
                      fill="none"
                      stroke="rgb(var(--v-theme-primary))"
                      strokeWidth="2"
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  )}
                  <defs>
                    <linearGradient id="waveGradient-rt" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(var(--v-theme-primary))" stopOpacity="0.4" />
                      <stop offset="100%" stopColor="rgb(var(--v-theme-primary))" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            </div>

            <hr className="v-divider" />

            <div style={{ padding: 20 }}>
              <div className="d-flex align-center mb-3">
                <Icon name="star" size={18} className="text-amber mr-2" />
                <span className="text-subtitle-2 font-weight-medium">实时评分</span>
              </div>
              {currentScore !== null ? (
                <div className="d-flex flex-wrap" style={{ gap: 16 }}>
                  <div
                    className="v-card v-card--variant-tonal flex-grow-1"
                    data-color={scoreColor(currentScore)}
                    style={{ minWidth: 200, padding: 16, display: 'flex', alignItems: 'center' }}
                  >
                    <div className={`noise-score-ring text-${scoreColor(currentScore)}`}>
                      <span className="text-h6 font-weight-bold">{currentScore}</span>
                    </div>
                    <div style={{ marginLeft: 16 }}>
                      <div className="text-subtitle-1 font-weight-bold">{scoreLabel(currentScore)}</div>
                      <div className="text-caption text-medium-emphasis">综合评分 (0-100)</div>
                    </div>
                  </div>

                  <div className="v-card border flex-grow-1" style={{ minWidth: 200, padding: 16 }}>
                    <div className="text-subtitle-2 font-weight-medium mb-2">扣分扣因</div>
                    {penaltyItems.map((item) => (
                      <div key={item.label} className="d-flex align-center justify-space-between mb-1">
                        <div className="d-flex align-center">
                          <Icon name={item.icon} size={14} className={`text-${item.color} mr-2`} />
                          <span className="text-body-2">{item.label}</span>
                        </div>
                        <div className="d-flex align-center" style={{ minWidth: 140 }}>
                          <div className="v-progress-linear flex-grow-1 mr-2">
                            <div
                              className="v-progress-linear__bar"
                              style={{ width: `${item.percent}%`, background: `rgb(var(--v-theme-${item.color}))` }}
                            />
                          </div>
                          <span className="text-caption font-weight-medium" style={{ minWidth: 36, textAlign: 'right' }}>
                            {item.percent}%
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-center text-medium-emphasis" style={{ padding: '16px 0' }}>
                  <Icon name="chartArc" size={32} className="mb-2" />
                  <div className="text-body-2">开始监测后将显示评分</div>
                </div>
              )}
            </div>

            <hr className="v-divider" />

            <div className="d-flex align-center" style={{ padding: 16 }}>
              {!isMonitoring ? (
                <button
                  type="button"
                  className="v-btn v-btn--size-large v-btn--variant-flat px-6"
                  data-color="success"
                  disabled={micPermissionState === 'denied' || micPermissionState === 'unavailable'}
                  onClick={onStart}
                >
                  <Icon name="play" size={18} />
                  开始监测
                </button>
              ) : (
                <button
                  type="button"
                  className="v-btn v-btn--size-large v-btn--variant-tonal px-6"
                  data-color="error"
                  onClick={onStop}
                >
                  <Icon name="stop" size={18} />
                  停止监测
                </button>
              )}
              <div className="flex-grow-1" />
              <button type="button" className="v-btn v-btn--variant-tonal" data-color="deep-purple" onClick={openCalibrate}>
                <Icon name="crosshairs" size={18} />
                校准
              </button>
            </div>
          </>
        ) : (
          <>
            {dateKeys.length === 0 ? (
              <div className="text-center text-medium-emphasis" style={{ padding: '48px 0' }}>
                <Icon name="chartArc" size={48} className="mb-3" />
                <div className="text-body-1">暂无统计报告</div>
                <div className="text-caption mt-1">在配置的晚自习时间段内，系统会自动记录并生成报告</div>
              </div>
            ) : (
              <>
                <div style={{ padding: 16 }}>
                  <div className="d-flex align-center flex-wrap mb-3" style={{ gap: 8 }}>
                    <Icon name="calendar" size={18} className="text-teal mr-1" />
                    <span className="text-subtitle-2 font-weight-medium">选择日期</span>
                    <div className="flex-grow-1" />
                    <button
                      type="button"
                      className="v-btn v-btn--size-x-small v-btn--variant-text"
                      data-color="error"
                      onClick={() => setConfirmClear('all')}
                    >
                      <Icon name="deleteSweep" size={16} />
                      清空全部
                    </button>
                  </div>
                  <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                    {dateKeys.map((dateKey) => (
                      <button
                        key={dateKey}
                        type="button"
                        className={`v-chip v-chip--size-small ${
                          selectedDate === dateKey ? 'v-chip--variant-elevated' : 'v-chip--variant-tonal'
                        }`}
                        data-color={selectedDate === dateKey ? 'primary' : undefined}
                        onClick={() => setSelectedDate(dateKey)}
                      >
                        <Icon name="calendar" size={14} />
                        {formatDateLabel(dateKey)}
                        <span className="v-chip v-chip--size-x-small" data-color="primary" style={{ marginLeft: 4 }}>
                          {meta.dates[dateKey].count}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <hr className="v-divider" />

                {meta.dates[selectedDate] && (
                  <div style={{ padding: '16px 16px 0' }}>
                    <div className="d-flex align-center flex-wrap" style={{ gap: 12 }}>
                      <div className="text-h6 font-weight-bold">{formatDateLabel(selectedDate)}</div>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color={scoreColor(meta.dates[selectedDate].avgScore)}>
                        均分 {meta.dates[selectedDate].avgScore}
                      </span>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                        {meta.dates[selectedDate].count} 条记录
                      </span>
                      <div className="flex-grow-1" />
                      <button
                        type="button"
                        className="v-btn v-btn--size-x-small v-btn--variant-text"
                        data-color="error"
                        onClick={() => setConfirmClear('date')}
                      >
                        <Icon name="trash" size={16} />
                        清空当日
                      </button>
                    </div>
                  </div>
                )}

                {dateReports.length === 0 && (
                  <div className="text-center text-medium-emphasis" style={{ padding: '32px 0' }}>
                    <Icon name="fileDocument" size={32} />
                    <div className="text-body-2 mt-1">该日期暂无报告数据</div>
                  </div>
                )}

                {dateReports.length > 0 && (
                  <div className="d-flex flex-wrap" style={{ padding: 16, gap: 8 }}>
                    {dateReports.map((report, index) => (
                      <button
                        key={report.startTime}
                        type="button"
                        className={`v-chip v-chip--size-small ${
                          selectedReportIndex === index ? 'v-chip--variant-elevated' : 'v-chip--variant-outlined'
                        }`}
                        data-color={selectedReportIndex === index ? 'teal' : undefined}
                        onClick={() => setSelectedReportIndex(index)}
                      >
                        {report.sessionName}
                        <span className="text-caption" style={{ marginLeft: 4 }}>
                          {formatTime(report.startTime)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {selectedReport && (
                  <div>
                    <div style={{ padding: '20px 20px 0' }}>
                      <div className="text-h6 font-weight-bold">{selectedReport.sessionName} 统计报告</div>
                    </div>

                    <div style={{ padding: 20 }}>
                      <div className="d-flex align-center mb-3">
                        <span className="report-section-line" />
                        <span className="text-subtitle-2 font-weight-bold ml-2">报告概览</span>
                      </div>
                      <div className="report-grid">
                        {[
                          ['时长', formatDuration(selectedReport.duration)],
                          ['表现', `${selectedReport.score} 分（${reportScoreLabel(selectedReport.score)}）`],
                          ['峰值', `${selectedReport.maxDb} dB`],
                          ['平均', `${selectedReport.avgDb} dB`],
                          ['超阈时长', formatSeconds(selectedReport.overThresholdDuration)],
                          ['打断次数', String(selectedReport.segmentCount)],
                        ].map(([label, value]) => (
                          <div className="report-stat-card" key={label}>
                            <div className="text-caption text-medium-emphasis">{label}</div>
                            <div className="text-h6 font-weight-bold">{value}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div style={{ padding: 20 }}>
                      <div className="d-flex align-center mb-3">
                        <span className="report-section-line" />
                        <span className="text-subtitle-2 font-weight-bold ml-2">噪音走势</span>
                      </div>
                      <div className="noise-waveform">
                        <svg width="100%" height="140" viewBox={`0 0 ${waveWidth} 140`} preserveAspectRatio="none">
                          {[20, 40, 60, 80].map((value) => (
                            <line
                              key={value}
                              x1="0"
                              y1={dbToY(value, 140)}
                              x2={waveWidth}
                              y2={dbToY(value, 140)}
                              stroke="currentColor"
                              strokeOpacity="0.1"
                              strokeDasharray="4,4"
                            />
                          ))}
                          <line
                            x1="0"
                            y1={dbToY(selectedReport.alertThresholdDb || 55, 140)}
                            x2={waveWidth}
                            y2={dbToY(selectedReport.alertThresholdDb || 55, 140)}
                            stroke="rgb(var(--v-theme-error))"
                            strokeOpacity="0.6"
                            strokeDasharray="6,3"
                            strokeWidth="1.5"
                          />
                          {reportWavePath && (
                            <path d={`${reportWavePath} L${waveWidth},140 L0,140 Z`} fill="url(#reportGrad)" opacity="0.3" />
                          )}
                          {reportWavePath && (
                            <path
                              d={reportWavePath}
                              fill="none"
                              stroke="rgb(var(--v-theme-primary))"
                              strokeWidth="1.5"
                              strokeLinejoin="round"
                            />
                          )}
                          <defs>
                            <linearGradient id="reportGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="rgb(var(--v-theme-primary))" stopOpacity="0.3" />
                              <stop offset="100%" stopColor="rgb(var(--v-theme-primary))" stopOpacity="0.02" />
                            </linearGradient>
                          </defs>
                        </svg>
                      </div>
                      <div className="text-caption text-medium-emphasis mt-2">
                        统计范围：{formatFullTime(selectedReport.startTime)} - {formatFullTime(selectedReport.endTime)}；
                        噪音报警阈值: {selectedReport.alertThresholdDb || 55} dB； 覆盖率:{' '}
                        {selectedReport.duration
                          ? (((selectedReport.samples.length * 2) / (selectedReport.duration / 1000)) * 100).toFixed(1)
                          : 0}
                        %
                      </div>
                    </div>

                    <div style={{ padding: 20 }}>
                      <div className="d-flex align-center mb-3">
                        <span className="report-section-line" />
                        <span className="text-subtitle-2 font-weight-bold ml-2">更多统计</span>
                      </div>
                      <div className="d-flex flex-wrap" style={{ gap: 16 }}>
                        <div className="v-card border flex-grow-1" style={{ padding: 16, minWidth: 280 }}>
                          <div className="text-subtitle-2 font-weight-medium mb-3">噪音等级分布</div>
                          <div className="d-flex" style={{ height: 16, borderRadius: 8, overflow: 'hidden' }}>
                            {levelDistribution(selectedReport).map((segment) => (
                              <div
                                key={segment.label}
                                style={{
                                  width: `${segment.percent}%`,
                                  backgroundColor: segment.color,
                                  minWidth: segment.percent > 0 ? 4 : 0,
                                }}
                              />
                            ))}
                          </div>
                          <div className="d-flex flex-wrap justify-center mt-3" style={{ gap: 12 }}>
                            {levelDistribution(selectedReport).map((segment) => (
                              <div className="d-flex align-center" key={`legend-${segment.label}`}>
                                <span
                                  style={{
                                    display: 'inline-block',
                                    width: 10,
                                    height: 10,
                                    borderRadius: 2,
                                    backgroundColor: segment.color,
                                    marginRight: 4,
                                  }}
                                />
                                <span className="text-caption text-medium-emphasis">
                                  {segment.label} ({segment.percent}%)
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="v-card border flex-grow-1" style={{ padding: 16, minWidth: 280 }}>
                          <div className="text-subtitle-2 font-weight-medium mb-3">扣分扣因 (越长扣分越多)</div>
                          {[
                            { label: '持续', color: 'amber', percent: Math.min(100, Math.round((selectedReport.scorePenalties.sustained / 40) * 100)) },
                            { label: '时长', color: 'orange', percent: Math.min(100, Math.round((selectedReport.scorePenalties.time / 30) * 100)) },
                            { label: '打断', color: 'pink', percent: Math.min(100, Math.round((selectedReport.scorePenalties.segment / 30) * 100)) },
                          ].map((item) => (
                            <div key={item.label} className="d-flex align-center mb-2">
                              <span className="text-body-2 mr-3" style={{ minWidth: 32 }}>{item.label}</span>
                              <div className="v-progress-linear flex-grow-1 mr-2" style={{ height: 10 }}>
                                <div
                                  className="v-progress-linear__bar"
                                  style={{ width: `${item.percent}%`, background: `rgb(var(--v-theme-${item.color}))` }}
                                />
                              </div>
                              <span className="text-body-2 font-weight-bold" style={{ minWidth: 40, textAlign: 'right' }}>
                                {item.percent}%
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* 校准对话框 */}
      <Modal
        open={calibrateOpen}
        onClose={() => setCalibrateOpen(false)}
        width={560}
        title={
          <span className="d-flex align-center">
            <Icon name="crosshairs" size={22} className="text-deep-purple mr-2" />
            <span className="text-h6 font-weight-bold">分贝校准</span>
          </span>
        }
      >
        <div className="v-card border mb-5" style={{ padding: 12 }}>
          <div className="text-caption text-medium-emphasis mb-1">当前校准值</div>
          <div className="d-flex align-center flex-wrap" style={{ gap: 24 }}>
            <div>
              <span className="text-body-2 text-medium-emphasis">基准分贝：</span>
              <span className="text-body-1 font-weight-bold">{calibration.baselineDb} dB</span>
            </div>
            <div>
              <span className="text-body-2 text-medium-emphasis">基准 RMS：</span>
              <span className="text-body-1 font-weight-bold font-monospace">
                {calibration.baselineRms != null ? calibration.baselineRms.toFixed(6) : '未校准'}
              </span>
            </div>
            <div>
              <span className="text-body-2 text-medium-emphasis">最大分贝：</span>
              <span className="text-body-1 font-weight-bold">{calibration.maxLevelDb} dB</span>
            </div>
          </div>
        </div>

        <div className="d-flex align-center mb-2">
          <Icon name="autoFix" size={18} className="text-primary mr-2" />
          <span className="text-subtitle-2 font-weight-medium">自动校准</span>
        </div>
        <div className="text-caption text-medium-emphasis mb-3">
          在已知环境分贝的场景下，输入当前环境的真实分贝值，点击开始后保持环境安静 3 秒。
        </div>
        <div className="d-flex align-center flex-wrap mb-5" style={{ gap: 12 }}>
          <input
            className="v-field v-field--density-compact"
            type="number"
            min={20}
            max={80}
            value={calibrateTarget}
            onChange={(event) => setCalibrateTarget(Number(event.target.value))}
            style={{ maxWidth: 160 }}
            aria-label="目标分贝"
          />
          <button
            type="button"
            className="v-btn v-btn--variant-tonal"
            data-color="deep-purple"
            disabled={!isMonitoring || calibrating}
            onClick={doAutoCalibrate}
          >
            <Icon name="crosshairs" size={18} />
            {calibrating ? '校准中…' : '开始校准'}
          </button>
          {!isMonitoring && <span className="text-caption text-warning">需先开启监测</span>}
          {calibrateMessage && (
            <span className={`text-caption ${calibrateSuccess ? 'text-success' : 'text-error'}`}>
              {calibrateMessage}
            </span>
          )}
        </div>

        <hr className="v-divider mb-5" />

        <div className="d-flex align-center mb-2">
          <Icon name="pencilRuler" size={18} className="text-orange mr-2" />
          <span className="text-subtitle-2 font-weight-medium">手动校准 / 参数调整</span>
        </div>
        <div className="text-caption text-medium-emphasis mb-3">直接输入校准参数。修改后点击保存生效。</div>
        <div className="d-flex align-center flex-wrap mb-4" style={{ gap: 12 }}>
          <input
            className="v-field v-field--density-compact"
            type="number"
            min={20}
            max={80}
            value={editBaselineDb}
            onChange={(event) => setEditBaselineDb(Number(event.target.value))}
            style={{ maxWidth: 160 }}
            aria-label="基准分贝"
          />
          <input
            className="v-field v-field--density-compact"
            value={editBaselineRms}
            onChange={(event) => setEditBaselineRms(event.target.value)}
            placeholder="如 0.003200"
            style={{ maxWidth: 200 }}
            aria-label="基准 RMS"
          />
          <input
            className="v-field v-field--density-compact"
            type="number"
            min={40}
            max={120}
            value={editMaxLevelDb}
            onChange={(event) => setEditMaxLevelDb(Number(event.target.value))}
            style={{ maxWidth: 180 }}
            aria-label="最大显示分贝"
          />
        </div>

        <div className="d-flex align-center">
          <button
            type="button"
            className="v-btn v-btn--variant-text"
            onClick={() => {
              const next = resetNoiseControlSettings()
              setCalibration(next)
              setEditBaselineDb(next.baselineDb)
              setEditBaselineRms(next.baselineRms != null ? String(next.baselineRms) : '')
              setEditMaxLevelDb(next.maxLevelDb)
            }}
          >
            <Icon name="restore" size={18} />
            恢复默认
          </button>
          <div className="flex-grow-1" />
          <button
            type="button"
            className="v-btn v-btn--variant-flat"
            data-color="primary"
            onClick={() => {
              const patch: { baselineDb: number; maxLevelDb: number; baselineRms?: number } = {
                baselineDb: editBaselineDb,
                maxLevelDb: editMaxLevelDb,
              }
              const rms = parseFloat(editBaselineRms)
              if (!Number.isNaN(rms) && rms > 0) patch.baselineRms = rms
              setCalibration(saveNoiseControlSettings(patch))
            }}
          >
            <Icon name="save" size={18} />
            保存校准
          </button>
        </div>
      </Modal>

      {/* 清空确认 */}
      <Modal
        open={confirmClear !== ''}
        onClose={() => setConfirmClear('')}
        width={360}
        title={<span className="text-h6">确认清空</span>}
        footer={
          <>
            <div className="flex-grow-1" />
            <button type="button" className="v-btn v-btn--variant-text" onClick={() => setConfirmClear('')}>
              取消
            </button>
            <button
              type="button"
              className="v-btn v-btn--variant-flat"
              data-color="error"
              onClick={() => {
                clearReports(confirmClear === 'all' ? undefined : selectedDate)
                setConfirmClear('')
                setSelectedReportIndex(0)
                setReportVersion((v) => v + 1)
              }}
            >
              确认清空
            </button>
          </>
        }
      >
        <p className="text-body-2">
          {confirmClear === 'all'
            ? '确定要清空所有日期的统计报告吗？此操作不可撤销。'
            : `确定要清空 ${formatDateLabel(selectedDate)} 的统计报告吗？此操作不可撤销。`}
        </p>
      </Modal>
    </Modal>
  )
}

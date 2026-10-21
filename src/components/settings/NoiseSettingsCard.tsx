import { useEffect, useState } from 'react'
import { MdiIcon } from '../MdiIcon'
import { SettingsCard } from './SettingsCard'
import { SettingItem } from './SettingItem'
import { getClient } from '../../lib/kv'
import { noiseService } from '../../lib/noise'
import { toast } from '../../lib/toast'

interface NoiseSession {
  name: string
  start: string
  duration: number
  enabled: boolean
}

interface SessionConfig {
  sessions: NoiseSession[]
  alertThresholdDb: number
}

const DEFAULT_CONFIG: SessionConfig = {
  sessions: [
    { name: '第1节晚自习', start: '19:20', duration: 60, enabled: true },
    { name: '第2节晚自习', start: '20:20', duration: 110, enabled: true },
  ],
  alertThresholdDb: 55,
}

function sessionEndTime(session: NoiseSession) {
  if (!session?.start || !session?.duration) return '--:--'
  const [h, m] = session.start.split(':').map(Number)
  const totalMin = h * 60 + m + (session.duration || 0)
  const eh = Math.floor(totalMin / 60) % 24
  const em = totalMin % 60
  return `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`
}

export function NoiseSettingsCard() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sessions, setSessions] = useState<NoiseSession[]>(DEFAULT_CONFIG.sessions)
  const [threshold, setThreshold] = useState(DEFAULT_CONFIG.alertThresholdDb)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const entry = await getClient().get<SessionConfig>('noise-session-config')
        const data = entry?.value
        if (data?.sessions) {
          setSessions(JSON.parse(JSON.stringify(data.sessions)))
          setThreshold(data.alertThresholdDb || 55)
        }
        setUpdatedAt(entry?.updatedAt ?? null)
      } catch {
        /* 使用默认配置 */
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const save = async () => {
    const normalized = sessions.map((session) => ({
      ...session,
      name: session.name.trim() || '未命名时段',
      duration: Math.min(300, Math.max(10, Number.isFinite(session.duration) ? session.duration : 10)),
    }))
    const alertThresholdDb = Math.min(90, Math.max(30, threshold))
    setSaving(true)
    try {
      const { entry, queued } = await getClient().set(
        'noise-session-config',
        { sessions: normalized, alertThresholdDb },
        { baseUpdatedAt: updatedAt },
      )
      setUpdatedAt(entry.updatedAt)
      setSessions(normalized)
      setThreshold(alertThresholdDb)
      noiseService.updateScheduleConfig({ sessions: normalized, alertThresholdDb })
      if (queued) {
        toast.warning('已保存到本地', '联网后会自动同步时段配置')
      } else {
        toast.success('已保存', '晚自习时段配置已生效')
      }
    } catch (error) {
      toast.error('保存失败', error instanceof Error ? error.message : '请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const reset = () => {
    setSessions(JSON.parse(JSON.stringify(DEFAULT_CONFIG.sessions)))
    setThreshold(DEFAULT_CONFIG.alertThresholdDb)
  }

  return (
    <SettingsCard title="噪音监测" icon="microphone">
      <div className="v-list">
        <SettingItem settingKey="noiseMonitor.enabled" />
        <hr className="v-divider" style={{ margin: '8px 0' }} />
        <SettingItem settingKey="noiseMonitor.autoStart" />
        <hr className="v-divider" style={{ margin: '8px 0' }} />
        <SettingItem settingKey="noiseMonitor.permissionDismissed" />
      </div>

      <hr className="v-divider" style={{ margin: '0 0 16px' }} />

      <div style={{ padding: '0 16px 16px' }}>
        <div className="d-flex align-center mb-4">
          <MdiIcon name="clock-edit-outline" size={22} className="text-teal mr-2" />
          <span className="text-subtitle-1 font-weight-bold">晚自习时间段</span>
          <div className="flex-grow-1" />
          <button
            type="button"
            className="v-btn v-btn--size-small v-btn--variant-tonal"
            data-color="primary"
            onClick={() =>
              setSessions((current) => [
                ...current,
                {
                  name: `第${current.length + 1}节晚自习`,
                  start: '19:00',
                  duration: 60,
                  enabled: true,
                },
              ])
            }
          >
            <MdiIcon name="plus" size={18} />
            添加时段
          </button>
        </div>

        <div className="text-caption text-medium-emphasis mb-4">
          配置晚自习时间段后，系统会在对应时段内自动开启噪音监测并记录统计报告。时间段外不会长期记录。
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 96, borderRadius: 24 }} />
        ) : (
          <>
            {sessions.map((session, index) => (
              <div className="v-card border rounded-xl mb-3" key={index}>
                <div className="v-card-text" style={{ padding: 16 }}>
                  <div className="d-flex align-center flex-wrap" style={{ gap: 12 }}>
                    <input
                      className="v-field v-field--density-compact"
                      value={session.name}
                      onChange={(event) =>
                        setSessions((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, name: event.target.value } : item,
                          ),
                        )
                      }
                      placeholder="名称"
                      style={{ maxWidth: 160 }}
                      aria-label="名称"
                    />
                    <input
                      className="v-field v-field--density-compact"
                      type="time"
                      value={session.start}
                      onChange={(event) =>
                        setSessions((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, start: event.target.value } : item,
                          ),
                        )
                      }
                      style={{ maxWidth: 170 }}
                      aria-label="开始时间"
                    />
                    <input
                      className="v-field v-field--density-compact"
                      type="number"
                      min={10}
                      max={300}
                      value={session.duration}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        const duration = Number.isFinite(value)
                          ? Math.min(300, Math.max(10, value))
                          : 10
                        setSessions((current) =>
                          current.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, duration } : item,
                          ),
                        )
                      }}
                      style={{ maxWidth: 130 }}
                      aria-label="时长"
                    />
                    <span className="text-caption text-medium-emphasis">
                      至 {sessionEndTime(session)}
                    </span>
                    <label className="d-flex align-center" style={{ gap: 8 }}>
                      <span className="text-caption text-medium-emphasis">启用</span>
                      <span className="v-switch">
                        <input
                          type="checkbox"
                          checked={session.enabled}
                          onChange={(event) =>
                            setSessions((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, enabled: event.target.checked }
                                  : item,
                              ),
                            )
                          }
                        />
                        <span className="v-switch__track">
                          <span className="v-switch__thumb" />
                        </span>
                      </span>
                    </label>
                    <div className="flex-grow-1" />
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                      data-color="error"
                      onClick={() => setSessions((current) => current.filter((_, i) => i !== index))}
                      aria-label="删除时段"
                    >
                      <MdiIcon name="delete" size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {sessions.length === 0 && (
              <div className="text-center text-medium-emphasis py-4">
                <MdiIcon name="clock-outline" size={20} className="mb-1" />
                <div className="text-caption">暂无时间段，点击上方「添加时段」创建</div>
              </div>
            )}
          </>
        )}

        <hr className="v-divider" style={{ margin: '20px 0' }} />

        <div className="d-flex align-center mb-4">
          <MdiIcon name="alert-decagram" size={22} className="text-orange mr-2" />
          <span className="text-subtitle-1 font-weight-bold">监测参数</span>
        </div>

        <div className="d-flex align-center flex-wrap mb-4" style={{ gap: 16 }}>
          <label className="d-flex align-center" style={{ gap: 8 }}>
            <span className="text-caption text-medium-emphasis">噪音报警阈值</span>
            <input
              className="v-field v-field--density-compact"
              type="number"
              min={30}
              max={90}
              value={threshold}
              onChange={(event) => {
                const value = Number(event.target.value)
                setThreshold(Number.isFinite(value) ? Math.min(90, Math.max(30, value)) : 55)
              }}
              style={{ width: 120 }}
            />
            <span className="text-caption text-medium-emphasis">dB</span>
          </label>
        </div>

        <div className="d-flex justify-end" style={{ gap: 12, marginBottom: 8 }}>
          <button type="button" className="v-btn v-btn--variant-text" onClick={reset}>
            <MdiIcon name="restore" size={18} />
            重置
          </button>
          <button
            type="button"
            className="v-btn v-btn--variant-flat"
            data-color="primary"
            disabled={saving}
            onClick={() => void save()}
          >
            <MdiIcon name="content-save-outline" size={18} />
            保存配置
          </button>
        </div>
      </div>
    </SettingsCard>
  )
}

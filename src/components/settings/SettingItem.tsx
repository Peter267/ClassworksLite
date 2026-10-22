import { useEffect, useState } from 'react'
import { MdiIcon } from '../MdiIcon'
import { useSettingsVersion } from '../../lib/hooks'
import { SETTING_DEFS, settings } from '../../lib/settings'
import { toast } from '../../lib/toast'

const KEY_ICONS: Record<string, string> = {
  'theme.mode': 'theme-light-dark',
  'font.size': 'format-size',
  'display.emptySubjectDisplay': 'card-outline',
  'display.showRandomButton': 'shuffle-variant',
  'display.showFullscreenButton': 'fullscreen',
  'display.cardHoverEffect': 'gesture-tap',
  'display.showAntiScreenBurnCard': 'monitor-shimmer',
  'display.showListCard': 'list-box',
  'display.showExamScheduleButton': 'calendar-check',
  'display.showUafTransfer': 'swap-vertical-bold',
  'display.showQuickTools': 'dialpad',
  'display.showPasteButtons': 'content-paste',
  'display.forceDesktopMode': 'monitor',
  'display.lateStudentsArePresent': 'clock-fast',
  'timeCard.enabled': 'clock-outline',
  'timeCard.use12h': 'clock-time-six-outline',
  'hitokoto.enabled': 'comment-quote',
  'hitokoto.online': 'web',
  'hitokoto.refreshInterval': 'timer-refresh',
  'noiseMonitor.enabled': 'microphone',
  'noiseMonitor.autoStart': 'play-circle-outline',
  'noiseMonitor.permissionDismissed': 'microphone-off',
  'edit.autoSave': 'content-save-outline',
  'edit.blockNonTodayAutoSave': 'calendar-lock',
  'edit.confirmNonTodaySave': 'calendar-alert',
  'edit.blockPastDataEdit': 'lock-clock',
  'edit.autoSavePromptText': 'text-box-outline',
  'edit.manualSavePromptText': 'text-box-outline',
  'edit.canvasClickClose': 'gesture-tap-button',
  'refresh.auto': 'refresh-auto',
  'refresh.interval': 'timer-outline',
  'sync.realtime': 'database-sync',
  'randomPicker.enabled': 'account-question',
  'randomPicker.animation': 'animation-play',
  'randomPicker.defaultCount': 'counter',
  'randomPicker.excludeAbsent': 'account-off',
  'randomPicker.excludeLate': 'clock-alert',
  'randomPicker.excludeExcluded': 'account-cancel',
  'randomPicker.mode': 'format-list-numbered',
  'randomPicker.minNumber': 'numeric-negative-1',
  'randomPicker.maxNumber': 'numeric',
  'server.classNumber': 'school',
  'background.enabled': 'image',
  'background.url': 'link',
  'background.blur': 'blur',
  'background.opacity': 'circle-half-full',
  'developer.enabled': 'developer-board',
  'developer.showTestCard': 'bug-outline',
}

export function SettingItem({
  settingKey,
  disabled,
  description,
}: {
  settingKey: string
  disabled?: boolean
  description?: string
}) {
  useSettingsVersion()
  const [menuOpen, setMenuOpen] = useState(false)
  const def = SETTING_DEFS[settingKey]
  const value = settings.get(settingKey)

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [menuOpen])

  if (!def) return null

  const icon = KEY_ICONS[settingKey] ?? 'cog-outline'
  const set = (next: boolean | number | string) => settings.set(settingKey, next)
  const isDefault = value === def.default
  const hasControl = def.type !== 'string' || Boolean(def.options)

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(message)
    } catch {
      toast.error('复制失败', '当前浏览器不允许访问剪贴板')
    }
    setMenuOpen(false)
  }

  const reset = () => {
    settings.reset(settingKey)
    setMenuOpen(false)
    toast.success('已重置为默认值')
  }

  return (
    <>
      <div className="v-list-item setting-item">
        <MdiIcon name={icon} size={21} className="setting-item-icon" />
        <div className="setting-title">
          <div className="v-list-item-title text-wrap">{def.label}</div>
          {(description ?? def.hint) && (
            <div className="v-list-item-subtitle">{description ?? def.hint}</div>
          )}
        </div>
        <div className="setting-item-append">
          {hasControl && (
            <div className="setting-control">
              {def.type === 'boolean' && (
                <label className="v-switch">
                  <input
                    type="checkbox"
                    checked={Boolean(value)}
                    disabled={disabled}
                    onChange={(event) => set(event.target.checked)}
                  />
                  <span className="v-switch__track">
                    <span className="v-switch__thumb" />
                  </span>
                </label>
              )}

              {def.type === 'string' && def.options && (
                <div className="setting-select-wrap">
                  <select
                    className="setting-select"
                    value={String(value)}
                    disabled={disabled}
                    onChange={(event) => set(event.target.value)}
                  >
                    {def.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <MdiIcon name="menu-down" size={24} className="setting-select-icon" />
                </div>
              )}

              {def.type === 'number' && (
                <div className="setting-number">
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                    disabled={disabled || Number(value) <= (def.min ?? 0)}
                    onClick={() => set(Math.max(def.min ?? 0, Number(value) - (def.step ?? 1)))}
                    aria-label="减小"
                  >
                    <MdiIcon name="minus" size={18} />
                  </button>
                  <input
                    className="setting-number-field"
                    type="number"
                    min={def.min}
                    max={def.max}
                    step={def.step ?? 1}
                    value={Number(value)}
                    disabled={disabled}
                    onChange={(event) => {
                      const next = Number(event.target.value)
                      if (Number.isFinite(next)) set(next)
                    }}
                    aria-label={def.label}
                  />
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                    disabled={disabled || Number(value) >= (def.max ?? 100)}
                    onClick={() => set(Math.min(def.max ?? 100, Number(value) + (def.step ?? 1)))}
                    aria-label="增大"
                  >
                    <MdiIcon name="plus" size={18} />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="setting-item-menu">
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
              disabled={disabled}
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="设置项操作"
              title="设置项操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MdiIcon name="dots-vertical" size={20} />
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="v-menu setting-menu" role="menu">
                  <button
                    type="button"
                    className="v-list-item"
                    role="menuitem"
                    onClick={() => void copy(settingKey, '设置ID已复制到剪贴板')}
                  >
                    <MdiIcon name="key" size={18} />
                    <span className="v-list-item-title">复制设置ID</span>
                  </button>
                  <button
                    type="button"
                    className="v-list-item"
                    role="menuitem"
                    onClick={() => void copy(String(value), '设置值已复制到剪贴板')}
                  >
                    <MdiIcon name="content-copy" size={18} />
                    <span className="v-list-item-title">复制设置值</span>
                  </button>
                  <hr className="v-divider" />
                  <button
                    type="button"
                    className="v-list-item"
                    role="menuitem"
                    disabled={isDefault}
                    onClick={reset}
                  >
                    <MdiIcon name="restore" size={18} />
                    <span className="v-list-item-title">重置为默认值</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {!hasControl && (
        <div className="setting-text-row">
          <input
            className="setting-text-input"
            type={def.secret ? 'password' : 'text'}
            value={String(value)}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set(event.target.value)}
            aria-label={def.label}
          />
        </div>
      )}
    </>
  )
}

export function SettingList({ items }: { items: string[] }) {
  return (
    <div className="v-list">
      {items.map((key) => (
        <SettingItem key={key} settingKey={key} />
      ))}
    </div>
  )
}

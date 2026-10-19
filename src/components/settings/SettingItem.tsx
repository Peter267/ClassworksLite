import { Icon, type IconName } from '../Icon'
import { useSettingsVersion } from '../../lib/hooks'
import { SETTING_DEFS, settings } from '../../lib/settings'

const KEY_ICONS: Record<string, IconName> = {
  'theme.mode': 'moon',
  'font.size': 'edit',
  'display.emptySubjectDisplay': 'grid',
  'display.dynamicSort': 'shuffle',
  'display.showRandomButton': 'shuffle',
  'display.showFullscreenButton': 'expand',
  'display.cardHoverEffect': 'grid',
  'display.enhancedTouchMode': 'edit',
  'display.showAntiScreenBurnCard': 'monitor',
  'display.showListCard': 'list',
  'display.showExamScheduleButton': 'calendarCheck',
  'display.showUafTransfer': 'swapVertical',
  'display.showQuickTools': 'edit',
  'display.showPasteButtons': 'copy',
  'display.forceDesktopMode': 'monitor',
  'display.lateStudentsArePresent': 'clock',
  'timeCard.enabled': 'clock',
  'timeCard.use12h': 'clock',
  'hitokoto.enabled': 'quote',
  'hitokoto.online': 'cloud',
  'hitokoto.refreshInterval': 'timer',
  'noiseMonitor.enabled': 'microphone',
  'noiseMonitor.autoStart': 'playCircle',
  'noiseMonitor.permissionDismissed': 'microphoneOff',
  'edit.autoSave': 'save',
  'edit.blockNonTodayAutoSave': 'calendar',
  'edit.refreshBeforeEdit': 'refresh',
  'edit.confirmNonTodaySave': 'calendarCheck',
  'edit.blockPastDataEdit': 'lock',
  'edit.autoSavePromptText': 'edit',
  'edit.manualSavePromptText': 'edit',
  'edit.canvasClickClose': 'edit',
  'refresh.auto': 'refresh',
  'refresh.interval': 'timer',
  'sync.realtime': 'cloud',
  'randomPicker.enabled': 'shuffle',
  'randomPicker.animation': 'playCircle',
  'randomPicker.defaultCount': 'users',
  'randomPicker.excludeAbsent': 'users',
  'randomPicker.excludeLate': 'clockAlert',
  'randomPicker.excludeExcluded': 'users',
  'randomPicker.mode': 'list',
  'randomPicker.minNumber': 'edit',
  'randomPicker.maxNumber': 'edit',
  'server.provider': 'database',
  'server.domain': 'external',
  'server.siteKey': 'key',
  'server.classNumber': 'account',
  'background.enabled': 'image',
  'background.url': 'external',
  'background.blur': 'image',
  'background.opacity': 'moon',
  'developer.enabled': 'settings',
  'developer.showTestCard': 'testTube',
}

export function SettingItem({
  settingKey,
  disabled,
}: {
  settingKey: string
  disabled?: boolean
}) {
  useSettingsVersion()
  const def = SETTING_DEFS[settingKey]
  const value = settings.get(settingKey)
  if (!def) return null

  const icon = KEY_ICONS[settingKey] ?? 'settings'
  const set = (next: boolean | number | string) => settings.set(settingKey, next)

  return (
    <>
      <div className="v-list-item setting-item">
        <Icon name={icon} size={20} className="mr-3 text-medium-emphasis" />
        <div className="v-list-item-title text-wrap">{def.label}</div>
        <div className="flex-grow-1" />
        <div className="d-flex align-center" style={{ marginLeft: 8 }}>
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
            <select
              className="v-field v-field--density-compact"
              value={String(value)}
              disabled={disabled}
              onChange={(event) => set(event.target.value)}
              style={{ width: 150 }}
            >
              {def.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}

          {def.type === 'number' && (
            <div className="d-flex align-center">
              <button
                type="button"
                className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                disabled={disabled || Number(value) <= (def.min ?? 0)}
                onClick={() => set(Math.max(def.min ?? 0, Number(value) - (def.step ?? 1)))}
              >
                <Icon name="minus" size={18} />
              </button>
              <input
                className="v-field v-field--density-compact"
                type="number"
                min={def.min}
                max={def.max}
                step={def.step ?? 1}
                value={Number(value)}
                disabled={disabled}
                onChange={(event) => set(Number(event.target.value))}
                style={{ width: 90, margin: '0 8px', textAlign: 'right' }}
              />
              <button
                type="button"
                className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                disabled={disabled || Number(value) >= (def.max ?? 100)}
                onClick={() => set(Math.min(def.max ?? 100, Number(value) + (def.step ?? 1)))}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>
          )}
        </div>
      </div>

      {def.type === 'string' && !def.options && (
        <div style={{ padding: '0 16px 8px' }}>
          <input
            className="v-field v-field--density-compact"
            value={String(value)}
            disabled={disabled}
            onChange={(event) => set(event.target.value)}
            style={{ width: '100%' }}
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

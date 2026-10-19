import { useEffect, useSyncExternalStore } from 'react'
import { Icon, type IconName } from './Icon'
import { relativeDayLabel } from '../lib/date'
import { useAppState } from '../lib/hooks'
import { messages } from '../lib/messages'
import { settings } from '../lib/settings'

export interface AppBarAction {
  icon: IconName
  label: string
  onClick: () => void
}

interface AppBarProps {
  onOpenSettings?: () => void
  actions?: React.ReactNode
  /** 子页面：显示返回按钮与标题 */
  back?: { label?: string; onBack: () => void }
  title?: string
  /** 设置页不显示设置入口 */
  hideSettings?: boolean
}

/**
 * 顶栏：对齐上游 v-app-bar —— 标题为「班级 - 今天的作业」。
 */
export function AppBar({ onOpenSettings, actions, back, title, hideSettings }: AppBarProps) {
  const state = useAppState()
  const unread = useSyncExternalStore(
    messages.subscribe,
    () => messages.unread,
    () => 0,
  )
  const className = settings.get<string>('server.classNumber') || '高三八班'
  const day = relativeDayLabel(state.date)
  const heading =
    title ?? (day === '今天' || day === '昨天' ? `${className} - ${day}的作业` : `${className} - ${day}的作业`)

  useEffect(() => {
    document.title = `${heading} · ClassworksLite`
  }, [heading])

  return (
    <header className="v-app-bar no-select">
      {back && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={back.onBack}
          aria-label={back.label ?? '返回'}
          title={back.label ?? '返回'}
        >
          <Icon name="arrowLeft" size={22} />
        </button>
      )}
      <div className="v-app-bar-title">{heading}</div>
      {actions}
      <button
        type="button"
        className="v-btn v-btn--icon v-btn--variant-text appbar-bell"
        onClick={() => messages.open()}
        aria-label="消息记录"
        title="消息记录"
      >
        <Icon name="bell" size={22} />
        {unread > 0 && <span className="appbar-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {!hideSettings && onOpenSettings && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置"
        >
          <Icon name="settings" size={22} />
        </button>
      )}
    </header>
  )
}

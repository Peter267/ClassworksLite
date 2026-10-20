import { useEffect } from 'react'
import { MdiIcon } from './MdiIcon'
import { relativeDayLabel } from '../lib/date'
import { useAppState } from '../lib/hooks'
import { messages } from '../lib/messages'
import { settings } from '../lib/settings'

interface AppBarProps {
  onOpenSettings?: () => void
  actions?: React.ReactNode
  /** 子页面：显示返回按钮与标题 */
  back?: { label?: string; onBack: () => void }
  /** 子页面：汉堡菜单按钮，用于切换左侧抽屉 */
  onMenu?: () => void
  menuExpanded?: boolean
  title?: string
  /** 设置页不显示设置入口 */
  hideSettings?: boolean
  /** 设置页不显示消息入口 */
  hideBell?: boolean
  /** 对齐上游 settings 页的 elevation="1" */
  elevation?: 1 | 2 | 4
}

/**
 * 顶栏：对齐上游 v-app-bar —— 标题为「班级 - 今天的作业」。
 */
export function AppBar({
  onOpenSettings,
  actions,
  back,
  onMenu,
  menuExpanded,
  title,
  hideSettings,
  hideBell,
  elevation = 4,
}: AppBarProps) {
  const state = useAppState()
  const className = settings.get<string>('server.classNumber') || '高三八班'
  const day = relativeDayLabel(state.date)
  const heading =
    title ?? (day === '今天' || day === '昨天' ? `${className} - ${day}的作业` : `${className} - ${day}的作业`)

  useEffect(() => {
    document.title = `${heading} · ClassworksLite`
  }, [heading])

  return (
    <header className="v-app-bar no-select" data-elevation={elevation}>
      {back && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={back.onBack}
          aria-label={back.label ?? '返回'}
          title={back.label ?? '返回'}
        >
          <MdiIcon name="arrow-left" size={24} />
        </button>
      )}
      {onMenu && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={onMenu}
          aria-label="设置分类"
          title="设置分类"
          aria-expanded={menuExpanded}
        >
          <MdiIcon name="menu" size={24} />
        </button>
      )}
      <div className="v-app-bar-title">{heading}</div>
      {actions}
      {!hideBell && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={() => messages.open()}
          aria-label="消息记录"
          title="消息记录"
        >
          <MdiIcon name="bell" size={24} />
        </button>
      )}
      {!hideSettings && onOpenSettings && (
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text"
          onClick={onOpenSettings}
          aria-label="设置"
          title="设置"
        >
          <MdiIcon name="cog" size={24} />
        </button>
      )}
    </header>
  )
}

import type { ReactNode } from 'react'
import { Icon, type IconName } from '../Icon'

/** 设置卡片：对齐 SettingsCard.vue（v-card border rounded-xl + 图标标题） */
export function SettingsCard({
  title,
  icon,
  subtitle,
  children,
  action,
  className = '',
}: {
  title: string
  icon?: IconName
  subtitle?: string
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <section className={`v-card border rounded-xl ${className}`}>
      <div className="v-card-title" style={{ gap: 8 }}>
        {icon && <Icon name={icon} size={22} className="text-primary mr-2" />}
        <span>{title}</span>
        <div className="flex-grow-1" />
        {action}
      </div>
      {subtitle && <div className="v-card-subtitle">{subtitle}</div>}
      <div className="v-card-text" style={{ padding: 0 }}>
        {children}
      </div>
    </section>
  )
}

import type { ReactNode } from 'react'
import { MdiIcon } from '../MdiIcon'

/** 对齐 SettingsCard.vue：v-card border rounded-lg elevation-2 + v-card-item 图标标题 */
export function SettingsCard({
  title,
  icon,
  subtitle,
  children,
  action,
  className = '',
}: {
  title: string
  icon?: string
  subtitle?: string
  children: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <section className={`v-card settings-card rounded-lg border ${className}`}>
      <div className="v-card-item">
        {icon && (
          <div className="v-card-item__prepend">
            <MdiIcon name={icon} size={28} />
          </div>
        )}
        <div className="v-card-item__content">
          <div className="v-card-title text-h6">{title}</div>
          {subtitle && <div className="v-card-subtitle">{subtitle}</div>}
        </div>
        {action && <div className="v-card-item__append">{action}</div>}
      </div>
      <div className="v-card-text">{children}</div>
    </section>
  )
}

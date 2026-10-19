import { useSyncExternalStore } from 'react'
import { Icon, type IconName } from '../Icon'
import { dismissToast, getToasts, subscribeToast, type ToastKind } from '../../lib/toast'

const TONE: Record<ToastKind, { icon: IconName; color: string; bg: string }> = {
  success: { icon: 'check', color: 'var(--success)', bg: 'var(--success-soft)' },
  error: { icon: 'warning', color: 'var(--error)', bg: 'var(--error-soft)' },
  warning: { icon: 'warning', color: 'var(--warning)', bg: 'var(--warning-soft)' },
  info: { icon: 'info', color: 'var(--info)', bg: 'var(--info-soft)' },
}

export function Toaster() {
  const items = useSyncExternalStore(subscribeToast, getToasts, getToasts)

  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[60] flex w-full max-w-[420px] -translate-x-1/2 flex-col gap-2 px-4">
      {items.map((item) => {
        const tone = TONE[item.kind]
        return (
          <div
            key={item.id}
            className="pointer-events-auto flex items-start gap-3 rounded-[16px] px-4 py-3 anim-pop"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            <span
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
              style={{ background: tone.bg, color: tone.color }}
            >
              <Icon name={tone.icon} size={14} strokeWidth={2.4} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] font-semibold leading-tight">{item.title}</div>
              {item.message && (
                <div className="mt-0.5 text-[12.5px] leading-snug" style={{ color: 'var(--text-2)' }}>
                  {item.message}
                </div>
              )}
            </div>
            <button
              type="button"
              className="-mr-1 shrink-0 rounded-md p-1"
              style={{ color: 'var(--text-3)' }}
              onClick={() => dismissToast(item.id)}
              aria-label="关闭提示"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

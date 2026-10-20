import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MdiIcon } from '../MdiIcon'
import { dismissToast, getToasts, subscribeToast, type ToastKind } from '../../lib/toast'

/** 对齐上游 GlobalMessage.vue：top right / tonal / multi-line / 2s。 */
const TONE: Record<ToastKind, { icon: string; color: string }> = {
  success: { icon: 'check-circle', color: 'success' },
  error: { icon: 'alert-circle', color: 'error' },
  warning: { icon: 'alert', color: 'warning' },
  info: { icon: 'information', color: 'info' },
}

export function Toaster() {
  const items = useSyncExternalStore(subscribeToast, getToasts, getToasts)
  const item = items[items.length - 1]
  if (!item || typeof document === 'undefined') return null
  const tone = TONE[item.kind]

  return createPortal(
    <div className="v-snackbar v-snackbar--top v-snackbar--right" role="status" aria-live="polite">
      <div
        className="v-snackbar__wrapper v-snackbar--variant-tonal v-snackbar--multi-line"
        data-color={tone.color}
      >
        <div className="v-snackbar__content d-flex align-center">
          <MdiIcon name={tone.icon} size={21} className="mr-2" />
          <div style={{ minWidth: 0 }}>
            <div className="text-subtitle-2 font-weight-medium">{item.title}</div>
            {item.message && <div className="text-body-2">{item.message}</div>}
          </div>
        </div>
        <div className="v-snackbar__actions">
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text"
            onClick={() => dismissToast(item.id)}
            aria-label="关闭提示"
          >
            <MdiIcon name="close" size={24} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

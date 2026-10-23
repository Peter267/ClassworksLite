import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { MdiIcon } from '../MdiIcon'
import {
  dismissToast,
  getToasts,
  subscribeToast,
  type ToastItem,
  type ToastKind,
} from '../../lib/toast'

/** 对齐上游 GlobalMessage.vue：top right / tonal / multi-line / 2s。 */
const TONE: Record<ToastKind, { icon: string; color: string }> = {
  success: { icon: 'check-circle', color: 'success' },
  error: { icon: 'alert-circle', color: 'error' },
  warning: { icon: 'alert', color: 'warning' },
  info: { icon: 'information', color: 'info' },
}

export function Toaster() {
  const items = useSyncExternalStore(subscribeToast, getToasts, getToasts)
  const latest = items[items.length - 1] ?? null
  const latestRef = useRef<ToastItem | null>(latest)
  latestRef.current = latest
  const [display, setDisplay] = useState<ToastItem | null>(latest)
  const [phase, setPhase] = useState<'idle' | 'enter' | 'leave'>('idle')
  const displayRef = useRef<ToastItem | null>(display)
  displayRef.current = display

  useEffect(() => {
    const current = displayRef.current
    if (!current && latest) {
      setDisplay(latest)
      setPhase('enter')
      return
    }
    if (current && (!latest || latest.id !== current.id)) {
      setPhase('leave')
    }
  }, [latest])

  useEffect(() => {
    if (phase === 'enter') {
      const timer = window.setTimeout(() => setPhase('idle'), 160)
      return () => window.clearTimeout(timer)
    }
    if (phase === 'leave') {
      const timer = window.setTimeout(() => {
        const next = latestRef.current
        setDisplay(next)
        setPhase(next ? 'enter' : 'idle')
      }, 160)
      return () => window.clearTimeout(timer)
    }
  }, [phase])

  if (!display || typeof document === 'undefined') return null
  const tone = TONE[display.kind]

  return createPortal(
    <div
      className={`v-snackbar v-snackbar--top v-snackbar--right ${
        phase === 'enter' ? 'v-snackbar--enter' : phase === 'leave' ? 'v-snackbar--leave' : ''
      }`}
      role="status"
      aria-live="polite"
    >
      <div
        className="v-snackbar__wrapper v-snackbar--variant-tonal v-snackbar--multi-line"
        data-color={tone.color}
      >
        <div className="v-snackbar__content d-flex align-center">
          <MdiIcon name={tone.icon} size={21} className="mr-2" />
          <div style={{ minWidth: 0 }}>
            <div className="text-subtitle-2 font-weight-medium">{display.title}</div>
            {display.message && <div className="text-body-2">{display.message}</div>}
          </div>
        </div>
        <div className="v-snackbar__actions">
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text"
            onClick={() => dismissToast(display.id)}
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

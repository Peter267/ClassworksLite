import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MdiIcon } from '../MdiIcon'
import { useMediaQuery } from '../../lib/hooks'

/** 嵌套弹窗只允许最上层处理 Tab/Escape，避免焦点被外层抢走 */
const modalStack: symbol[] = []

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** 最大宽度，默认 560 */
  width?: number
  /** 移动端全屏 */
  fullscreenOnMobile?: boolean
  /** 关闭按钮 */
  closable?: boolean
  className?: string
  /** 点击遮罩关闭 */
  maskClosable?: boolean
  /** 对话框主体是否使用紧凑内边距 */
  bare?: boolean
}

/**
 * 对话框：对齐 Vuetify 的 v-dialog / v-card 结构。
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
  fullscreenOnMobile = false,
  closable = true,
  className = '',
  maskClosable = true,
  bare = false,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const mobile = useMediaQuery('(max-width: 599px)')
  const fullscreen = fullscreenOnMobile && mobile
  const [scrollbarWidth, setScrollbarWidth] = useState(0)
  const onCloseRef = useRef(onClose)
  const closableRef = useRef(closable)
  onCloseRef.current = onClose
  closableRef.current = closable

  useEffect(() => {
    if (!open) return
    const token = Symbol('modal')
    modalStack.push(token)
    const previousActive =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    const previousPadding = document.body.style.paddingRight
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    setScrollbarWidth(scrollbar > 0 ? scrollbar : 0)
    document.body.style.overflow = 'hidden'
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`

    const onKey = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== token) return
      if (event.key === 'Escape' && closableRef.current) {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0)
      if (focusable.length === 0) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panelRef.current.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panelRef.current.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      const index = modalStack.lastIndexOf(token)
      if (index >= 0) modalStack.splice(index, 1)
      document.body.style.overflow = previousOverflow
      document.body.style.paddingRight = previousPadding
      setScrollbarWidth(0)
      window.removeEventListener('keydown', onKey)
      if (previousActive?.isConnected) previousActive.focus()
    }
  }, [open])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="v-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      style={scrollbarWidth ? { paddingRight: 24 + scrollbarWidth } : undefined}
    >
      <div
        className="absolute inset-0"
        onClick={maskClosable ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`v-dialog ${fullscreen ? 'v-dialog--fullscreen' : ''} ${className}`}
        style={{
          maxWidth: width,
          maxHeight: fullscreen ? undefined : 'calc(100dvh - 48px)',
          display: 'flex',
          flexDirection: 'column',
          outline: 'none',
          position: 'relative',
        }}
      >
        {(title || closable) && (
          <header className="d-flex align-center" style={{ padding: '8px 8px 8px 16px', gap: 8 }}>
            <div className="flex-grow-1" style={{ minWidth: 0 }}>
              {title && (
                <div id={titleId} className="v-card-title" style={{ padding: 0, minHeight: 40 }}>
                  {title}
                </div>
              )}
              {subtitle && (
                <div className="v-card-subtitle" style={{ padding: '4px 0 0' }}>
                  {subtitle}
                </div>
              )}
            </div>
            {closable && (
              <button
                type="button"
                className="v-btn v-btn--icon v-btn--variant-text"
                style={{ width: 48, height: 48, minWidth: 48 }}
                onClick={onClose}
                aria-label="关闭"
              >
                <MdiIcon name="close" size={24} />
              </button>
            )}
          </header>
        )}

        <div
          className="v-card-text"
          style={{
            minHeight: 0,
            flex: '1 1 auto',
            overflowY: 'auto',
            padding: bare ? 0 : '8px 16px 16px',
          }}
        >
          {children}
        </div>

        {footer && (
          <footer className="v-card-actions" style={{ padding: '8px 16px 16px' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** 极简确认对话框（Vuetify 风格） */
export function ConfirmDialog({
  open,
  title,
  text,
  confirmText = '确认',
  cancelText = '取消',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: ReactNode
  text: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={<span className="text-h6">{title}</span>}
      width={420}
      footer={
        <>
          <div className="flex-grow-1" />
          <button type="button" className="v-btn v-btn--variant-text" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className="v-btn v-btn--variant-flat"
            data-color={danger ? 'error' : 'primary'}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </>
      }
    >
      <p className="text-body-2">{text}</p>
    </Modal>
  )
}

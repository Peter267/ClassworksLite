import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { DEFAULT_TEMPLATE, KEYPAD_ROWS, QUICK_TEXTS } from '../lib/defaults'
import { longDate } from '../lib/date'
import { useSetting } from '../lib/hooks'
import { KEYS } from '../lib/store'
import { getClient } from '../lib/kv'
import { toast } from '../lib/toast'
import type { HomeworkTemplate } from '../lib/types'

interface EditDialogProps {
  open: boolean
  title: string
  initialContent: string
  date: Date
  isPast: boolean
  /** 自定义卡片：允许改名与删除 */
  custom?: boolean
  /** 只读会话：可以查看内容，但禁止保存与删除 */
  readOnly?: boolean
  onRename?: (name: string) => boolean
  onDelete?: () => boolean
  onSave: (content: string) => boolean | Promise<boolean>
  onClose: () => void
}

export function EditDialog({
  open,
  title,
  initialContent,
  date,
  isPast,
  custom,
  readOnly,
  onRename,
  onDelete,
  onSave,
  onClose,
}: EditDialogProps) {
  const [content, setContent] = useState(initialContent)
  const [nameDraft, setNameDraft] = useState(title)
  const [showPaste] = useSetting<boolean>('display.showPasteButtons')
  const [showQuickTools] = useSetting<boolean>('display.showQuickTools')
  const [canvasClose] = useSetting<boolean>('edit.canvasClickClose')
  const [autoSave] = useSetting<boolean>('edit.autoSave')
  const [autoSaveText] = useSetting<string>('edit.autoSavePromptText')
  const [manualSaveText] = useSetting<string>('edit.manualSavePromptText')
  const [template, setTemplate] = useState<HomeworkTemplate | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const openedRef = useRef(false)
  /** 已落盘的内容，避免自动保存/关闭时重复提交 */
  const savedContent = useRef(initialContent.trim())
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!open) {
      openedRef.current = false
      return
    }
    // 只在打开时同步一次初始内容，避免同步轮询覆盖正在输入的文字
    if (openedRef.current) return
    openedRef.current = true

    const initial = initialContent || ''
    savedContent.current = initial.trim()
    setNameDraft(title)
    setContent(initial === '' || initial.endsWith('\n') ? initial : `${initial}\n`)
    const timer = setTimeout(() => textareaRef.current?.focus(), 60)

    void (async () => {
      try {
        const entry = await getClient().get<HomeworkTemplate>(KEYS.template)
        setTemplate(entry?.value ?? DEFAULT_TEMPLATE)
      } catch {
        // 离线读取失败时使用内置动作，避免模板区完全空白
        setTemplate(DEFAULT_TEMPLATE)
      }
    })()

    return () => clearTimeout(timer)
  }, [open, initialContent, title])

  /* 自适应高度 */
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 150)}px`
  }, [content, open])

  /* 输入停顿 2 秒自动保存（F1）；只有写入被接受后才更新已保存基线 */
  useEffect(() => {
    if (!open || !autoSave || readOnly) return
    let cancelled = false
    const timer = setTimeout(() => {
      const next = content.trim()
      // 自定义卡片清空等于删除，等关闭时再处理，避免输入中途卡片突然消失
      if (custom && next === '') return
      if (next === savedContent.current) return
      void (async () => {
        try {
          const saved = await onSaveRef.current(next)
          if (saved && !cancelled) savedContent.current = next
        } catch {
          /* store 已提示错误，保留未保存状态 */
        }
      })()
    }, 2000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [content, open, autoSave, custom, readOnly])

  const commit = useCallback(async () => {
    // 只读会话不提交任何改动，直接关闭
    if (readOnly) {
      onClose()
      return
    }
    const next = content.trim()
    if (custom && next === '' && savedContent.current === '') {
      // 空白自定义卡片：清空即删除（F11）
      const deleted = onDelete ? onDelete() : true
      if (deleted) onClose()
      return
    }
    if (next !== savedContent.current) {
      try {
        const saved = await onSaveRef.current(next)
        if (!saved) return
        savedContent.current = next
      } catch {
        return
      }
    }
    onClose()
  }, [content, custom, onDelete, onClose, readOnly])

  const insertAtCursor = (text: string) => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? content.length
    const end = el.selectionEnd ?? start
    const next = content.slice(0, start) + text + content.slice(end)
    setContent(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + text.length
      el.setSelectionRange(pos, pos)
    })
  }

  const deleteBackward = () => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? content.length
    const end = el.selectionEnd ?? start
    if (start === end) {
      if (start <= 0) return
      setContent(content.slice(0, start - 1) + content.slice(start))
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start - 1, start - 1)
      })
    } else {
      setContent(content.slice(0, start) + content.slice(end))
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(start, start)
      })
    }
  }

  const paste = async (andDone: boolean) => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) {
        toast.warning('剪贴板为空', '没有可粘贴的内容')
        return
      }
      const el = textareaRef.current
      const start = el?.selectionStart ?? content.length
      const end = el?.selectionEnd ?? start
      const next = content.slice(0, start) + text + content.slice(end)
      setContent(next)
      if (andDone) {
        const saved = await onSave(next.trim())
        if (saved) {
          savedContent.current = next.trim()
          onClose()
        }
      } else {
        requestAnimationFrame(() => {
          el?.focus()
          const pos = start + text.length
          el?.setSelectionRange(pos, pos)
        })
      }
    } catch {
      toast.error('无法读取剪贴板', '请允许浏览器访问剪贴板，或手动粘贴')
    }
  }

  const books = useMemo(() => {
    if (!template) return [] as { book: string; pages: string[] }[]
    const merged: Record<string, string[]> = {
      ...(template.commonSubject?.books ?? {}),
      ...(template.subjects?.[title]?.books ?? {}),
    }
    return Object.entries(merged).map(([book, pages]) => ({
      book,
      pages: Array.isArray(pages) ? pages : [],
    }))
  }, [template, title])

  return (
    <Modal
      open={open}
      onClose={() => {
        void commit()
      }}
      title={<span className="text-truncate">{title}</span>}
      subtitle={readOnly ? '只读访问，无法修改' : autoSave ? autoSaveText : manualSaveText}
      width={900}
      fullscreenOnMobile
      maskClosable={canvasClose}
    >
      <div className="d-flex">
        <div className="flex-grow-1" style={{ minWidth: 0 }}>
          {custom && !readOnly && (
            <div className="d-flex align-center mb-3" style={{ gap: 8, maxWidth: 480 }}>
              <span className="text-caption" style={{ whiteSpace: 'nowrap', color: 'var(--text-3)' }}>
                重命名
              </span>
              <input
                className="v-field"
                style={{ flex: 1, minWidth: 0 }}
                value={nameDraft}
                placeholder="卡片名称"
                aria-label="卡片名称"
                onChange={(event) => setNameDraft(event.target.value)}
                onBlur={() => {
                  const next = nameDraft.trim()
                  if (next && next !== title) {
                    const renamed = onRename ? onRename(next) : true
                    if (!renamed) setNameDraft(title)
                  }
                  if (!next) setNameDraft(title)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    ;(event.target as HTMLInputElement).blur()
                  }
                }}
              />
              <button
                type="button"
                className="v-btn v-btn--variant-text"
                data-color="error"
                onClick={() => {
                  const deleted = onDelete ? onDelete() : true
                  if (deleted) onClose()
                }}
              >
                <Icon name="trash" size={16} />
                删除
              </button>
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="v-field v-textarea-filled"
            style={{ width: '100%', maxWidth: 480, fontSize: 16, lineHeight: 1.5 }}
            rows={5}
            placeholder="使用换行表示分条"
            value={content}
            readOnly={readOnly}
            onChange={(event) => setContent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                commit()
              }
            }}
          />

          {showPaste && !readOnly && (
            <div className="d-flex justify-center mt-2" style={{ gap: 8 }}>
              <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={() => void paste(false)}>
                <Icon name="copy" size={14} />
                粘贴
              </button>
              <button
                type="button"
                className="v-btn v-btn--size-small v-btn--variant-flat"
                data-color="primary"
                onClick={() => void paste(true)}
              >
                <Icon name="copy" size={14} />
                粘贴并完成
              </button>
            </div>
          )}

          {template && (
            <div className="mt-4">
              {books.length > 0 || (template?.actions?.length ?? 0) > 0 ? (
                <div className="d-flex flex-column" style={{ gap: 12 }}>
                  <div>
                    {books.map(({ book, pages }) => (
                      <div key={book} className="mb-1">
                        <button
                          type="button"
                          className={`v-chip v-chip--variant-flat mr-1 mb-1 ${content.includes(book) ? 'v-chip--variant-elevated' : ''}`}
                          data-color={content.includes(book) ? 'success' : undefined}
                          onClick={() => {
                            if (content.includes(book)) {
                              setContent(
                                content
                                  .split('\n')
                                  .filter((line) => !line.includes(book))
                                  .join('\n'),
                              )
                            } else {
                              setContent((prev) => (prev.trim() ? `${prev.trim()}\n${book}` : book))
                            }
                          }}
                        >
                          {book}
                        </button>
                        {content.includes(book) && (
                          <div className="d-flex flex-wrap" style={{ gap: 4, paddingLeft: 16, marginTop: 8 }}>
                            {pages.map((page) => (
                              <button
                                key={page}
                                type="button"
                                className={`v-chip ${content.includes(page) ? 'v-chip--variant-elevated' : 'v-chip--variant-flat'}`}
                                data-color={content.includes(page) ? 'info' : undefined}
                                onClick={() => insertAtCursor(page)}
                              >
                                {page}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {template?.actions && template.actions.length > 0 && (
                    <div>
                      {template.actions.map((action) => (
                        <button
                          key={action}
                          type="button"
                          className="v-chip v-chip--variant-flat mr-1 mb-1"
                          data-color="primary"
                          onClick={() => insertAtCursor(action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center text-body-2 text-disabled mt-2">暂无可用的模板</div>
              )}
            </div>
          )}
        </div>

        {showQuickTools && (
          <div className="quick-tools ml-4" style={{ minWidth: 180 }}>
            <div className="numeric-keypad mb-4">
              {KEYPAD_ROWS.map((row, rowIndex) => (
                <div key={rowIndex} className="keypad-row">
                  {row.map((key) => (
                    <button
                      key={key}
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-tonal keypad-btn"
                      onClick={() => (key === '←' ? deleteBackward() : insertAtCursor(key))}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              ))}
              <div className="keypad-row">
                <button
                  type="button"
                  className="v-btn v-btn--size-small v-btn--variant-tonal keypad-btn space-btn"
                  onClick={() => insertAtCursor(' ')}
                >
                  空格
                </button>
                <button
                  type="button"
                  className="v-btn v-btn--size-small v-btn--variant-tonal keypad-btn space-btn"
                  onClick={() => insertAtCursor('\n')}
                >
                  换行
                </button>
              </div>
            </div>

            <div className="quick-text-grid">
              {QUICK_TEXTS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="v-btn v-btn--size-small v-btn--variant-flat quick-text-btn"
                  onClick={() => insertAtCursor(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {isPast && (
        <div className="v-alert v-alert--variant-tonal mb-4" data-color="warning">
          <div className="d-flex flex-column">
            <div className="text-h6 mb-1">你打算修改历史？</div>
            <div className="text-body-2">
              这是 {longDate(date)} 的作业 • 请谨慎操作，确保不会覆盖重要数据
            </div>
          </div>
        </div>
      )}

      <div className="text-center text-body-2 text-disabled" style={{ marginTop: 20, marginBottom: 20 }}>
        点击空白处完成编辑
      </div>
    </Modal>
  )
}

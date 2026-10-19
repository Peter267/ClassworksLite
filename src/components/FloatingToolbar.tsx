import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { addDays, isSameDay, toISODate, today } from '../lib/date'
import { useAppState, useSetting } from '../lib/hooks'
import { settings } from '../lib/settings'
import { store } from '../lib/store'
import { DatePicker } from './ui/DatePicker'
import { toast } from '../lib/toast'

/** 底部悬浮工具栏（对齐 FloatingToolbar.vue） */
export function FloatingToolbar({ onCopied }: { onCopied?: (count: number) => void }) {
  const state = useAppState()
  const [fontSize] = useSetting<number>('font.size')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copying, setCopying] = useState(false)
  const isToday = isSameDay(state.date, today())
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    const onClick = (event: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(event.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [pickerOpen])

  const zoom = (direction: 'out' | 'up') => {
    const next = Math.max(16, Math.min(100, fontSize + (direction === 'up' ? 2 : -2)))
    settings.set('font.size', next)
  }

  const goDate = (date: Date) => {
    setPickerOpen(false)
    void store.goToDate(date)
    const url = new URL(window.location.href)
    url.searchParams.set('date', toISODate(date).replaceAll('-', ''))
    window.history.replaceState({}, '', url)
  }

  const copyToToday = async () => {
    setCopying(true)
    try {
      const count = await store.copyToToday()
      if (count > 0) {
        toast.success('已复制到今天', `共 ${count} 张作业卡片`)
        onCopied?.(count)
      } else {
        toast.info('没有可复制的作业', '今天的卡片已存在或当前日期没有内容')
      }
    } finally {
      setCopying(false)
      const url = new URL(window.location.href)
      url.searchParams.delete('date')
      window.history.replaceState({}, '', url)
    }
  }

  return (
    <div className="floating-toolbar-container">
      <div className="v-card floating-toolbar">
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
          title="查看昨天"
          onClick={() => goDate(addDays(state.date, -1))}
        >
          <Icon name="left" size={22} />
        </button>
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
          title="缩小字体"
          onClick={() => zoom('out')}
        >
          <Icon name="minus" size={22} />
        </button>
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
          title="放大字体"
          onClick={() => zoom('up')}
        >
          <Icon name="plus" size={22} />
        </button>

        <div style={{ position: 'relative' }} ref={popRef}>
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
            title="选择日期"
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Icon name="calendar" size={22} />
          </button>
          {pickerOpen && (
            <div className="date-picker-card">
              <DatePicker
                value={state.date}
                onChange={(date) => {
                  setPickerOpen(false)
                  goDate(date)
                }}
              />
            </div>
          )}
        </div>

        <button
          type="button"
          className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
          title="刷新数据"
          onClick={() => void store.refresh()}
        >
          <Icon name="refresh" size={22} />
        </button>

        {!isToday && (
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text toolbar-btn"
            title="查看明天"
            onClick={() => goDate(addDays(state.date, 1))}
          >
            <Icon name="right" size={22} />
          </button>
        )}
      </div>

      {!isToday && (
        <button
          type="button"
          className="v-btn v-btn--size-large v-btn--variant-flat side-action-btn"
          data-color="primary"
          disabled={copying}
          onClick={() => void copyToToday()}
        >
          <Icon name="copy" size={20} />
          复制到今天
        </button>
      )}
    </div>
  )
}

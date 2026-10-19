import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 日期选择器：对齐 Vuetify v-date-picker 的月视图。 */
export function DatePicker({
  value,
  onChange,
}: {
  value: Date
  onChange: (date: Date) => void
}) {
  const [view, setView] = useState(() => startOfMonth(value))

  useEffect(() => {
    setView(startOfMonth(value))
  }, [value])

  const cells = useMemo(() => {
    const first = startOfMonth(view)
    const start = new Date(first)
    start.setDate(1 - first.getDay())
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      return date
    })
  }, [view])

  const today = new Date()

  return (
    <div className="date-picker">
      <div className="date-picker-header">
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          aria-label="上个月"
        >
          <Icon name="left" size={18} />
        </button>
        <div className="date-picker-title">
          {view.getFullYear()}年{view.getMonth() + 1}月
        </div>
        <button
          type="button"
          className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          aria-label="下个月"
        >
          <Icon name="right" size={18} />
        </button>
      </div>

      <div className="date-picker-weekdays">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="date-picker-grid">
        {cells.map((date) => {
          const outside = date.getMonth() !== view.getMonth()
          const selected = sameDay(date, value)
          const isToday = sameDay(date, today)
          return (
            <button
              key={date.toISOString()}
              type="button"
              className={[
                'date-picker-day',
                outside ? 'outside' : '',
                selected ? 'selected' : '',
                isToday ? 'today' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onChange(date)}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>

      <div className="date-picker-actions">
        <button
          type="button"
          className="v-btn v-btn--size-small v-btn--variant-text"
          data-color="primary"
          onClick={() => onChange(today)}
        >
          今天
        </button>
      </div>
    </div>
  )
}

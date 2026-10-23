import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../Icon'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']
const MONTHS = Array.from({ length: 12 }, (_, index) => `${index + 1}月`)
const YEARS_PER_PAGE = 12

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

/** 日期选择器：对齐 Vuetify v-date-picker 的月视图，并支持快速翻阅月份 / 年份。 */
export function DatePicker({
  value,
  onChange,
}: {
  value: Date
  onChange: (date: Date) => void
}) {
  const [view, setView] = useState(() => startOfMonth(value))
  const [direction, setDirection] = useState<'next' | 'prev'>('next')
  const [panel, setPanel] = useState<'days' | 'months' | 'years'>('days')
  const [yearPageStart, setYearPageStart] = useState(
    () => Math.floor(value.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE,
  )

  useEffect(() => {
    setView(startOfMonth(value))
  }, [value])

  useEffect(() => {
    setYearPageStart(Math.floor(view.getFullYear() / YEARS_PER_PAGE) * YEARS_PER_PAGE)
  }, [view])

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

  const stepMonth = (delta: number) => {
    setDirection(delta > 0 ? 'next' : 'prev')
    setView(new Date(view.getFullYear(), view.getMonth() + delta, 1))
  }

  const stepYear = (delta: number) => {
    setDirection(delta > 0 ? 'next' : 'prev')
    setView(new Date(view.getFullYear() + delta, view.getMonth(), 1))
  }

  const chooseMonth = (month: number) => {
    setDirection(month > view.getMonth() ? 'next' : 'prev')
    setView(new Date(view.getFullYear(), month, 1))
    setPanel('days')
  }

  const chooseYear = (year: number) => {
    setDirection(year > view.getFullYear() ? 'next' : 'prev')
    setView(new Date(year, view.getMonth(), 1))
    setPanel('days')
  }

  return (
    <div className="date-picker">
      <div className="date-picker-header">
        <div className="date-picker-nav">
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
            onClick={() => stepMonth(-1)}
            aria-label="上个月"
          >
            <Icon name="left" size={18} />
          </button>
          <button
            type="button"
            className="date-picker-nav-label"
            onClick={() => setPanel((current) => (current === 'months' ? 'days' : 'months'))}
            aria-label="选择月份"
            aria-expanded={panel === 'months'}
          >
            {view.getMonth() + 1}月
            <Icon name="down" size={14} className="date-picker-nav-caret" />
          </button>
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
            onClick={() => stepMonth(1)}
            aria-label="下个月"
          >
            <Icon name="right" size={18} />
          </button>
        </div>

        <div className="date-picker-nav">
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
            onClick={() => stepYear(-1)}
            aria-label="上一年"
          >
            <Icon name="left" size={18} />
          </button>
          <button
            type="button"
            className="date-picker-nav-label"
            onClick={() => setPanel((current) => (current === 'years' ? 'days' : 'years'))}
            aria-label="选择年份"
            aria-expanded={panel === 'years'}
          >
            {view.getFullYear()}年
            <Icon name="down" size={14} className="date-picker-nav-caret" />
          </button>
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
            onClick={() => stepYear(1)}
            aria-label="下一年"
          >
            <Icon name="right" size={18} />
          </button>
        </div>
      </div>

      {panel === 'months' ? (
        <div className="date-picker-panel" role="group" aria-label="选择月份">
          <div className="date-picker-panel-grid date-picker-panel-grid--months">
            {MONTHS.map((label, index) => (
              <button
                key={label}
                type="button"
                className={`date-picker-panel-item ${
                  index === view.getMonth() ? 'active' : ''
                }`}
                onClick={() => chooseMonth(index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : panel === 'years' ? (
        <div className="date-picker-panel" role="group" aria-label="选择年份">
          <div className="date-picker-panel-nav">
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
              onClick={() => setYearPageStart((current) => current - YEARS_PER_PAGE)}
              aria-label="上一页年份"
            >
              <Icon name="left" size={18} />
            </button>
            <span className="date-picker-panel-range">
              {yearPageStart}年 - {yearPageStart + YEARS_PER_PAGE - 1}年
            </span>
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text date-picker-nav-btn"
              onClick={() => setYearPageStart((current) => current + YEARS_PER_PAGE)}
              aria-label="下一页年份"
            >
              <Icon name="right" size={18} />
            </button>
          </div>
          <div className="date-picker-panel-grid">
            {Array.from({ length: YEARS_PER_PAGE }, (_, index) => yearPageStart + index).map(
              (year) => (
                <button
                  key={year}
                  type="button"
                  className={`date-picker-panel-item ${
                    year === view.getFullYear() ? 'active' : ''
                  }`}
                  onClick={() => chooseYear(year)}
                >
                  {year}
                </button>
              ),
            )}
          </div>
        </div>
      ) : (
        <div
          key={`${view.getFullYear()}-${view.getMonth()}`}
          className={`date-picker-month picker-${direction}`}
        >
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
        </div>
      )}

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

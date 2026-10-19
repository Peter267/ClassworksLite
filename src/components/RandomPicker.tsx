import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { useAppState } from '../lib/hooks'
import { settings } from '../lib/settings'

/** 均匀洗牌（Fisher-Yates）：避免 sort(() => Math.random()-0.5) 的明显偏置（F9） */
function shuffle<T>(items: T[]): T[] {
  const list = [...items]
  const random = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const buffer = new Uint32Array(1)
      crypto.getRandomValues(buffer)
      return buffer[0] / 2 ** 32
    }
    return Math.random()
  }
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[list[i], list[j]] = [list[j], list[i]]
  }
  return list
}

/**
 * 随机点名：对齐上游 RandomPicker.vue。
 * 两阶段：人数/模式/过滤设置 → 抽取动画 → 结果卡片（可单个重抽）。
 */
export function RandomPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useAppState()
  const { absent, late, exclude } = state.board.attendance

  const [count, setCount] = useState(1)
  const [started, setStarted] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [highlighted, setHighlighted] = useState<number[]>([])
  const [pickerMode, setPickerMode] = useState<'name' | 'number'>('name')
  const [minNumber, setMinNumber] = useState(1)
  const [maxNumber, setMaxNumber] = useState(60)
  const [filters, setFilters] = useState({
    excludeAbsent: true,
    excludeLate: false,
    excludeExcluded: true,
  })
  const timer = useRef<number | null>(null)

  /* 打开时重置为设置值（与上游 watch dialog 一致） */
  useEffect(() => {
    if (!open) {
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = null
      return
    }
    setCount(settings.get<number>('randomPicker.defaultCount'))
    setStarted(false)
    setAnimating(false)
    setPicked([])
    setHighlighted([])
    setPickerMode(settings.get<string>('randomPicker.mode') === 'number' ? 'number' : 'name')
    setMinNumber(settings.get<number>('randomPicker.minNumber'))
    setMaxNumber(settings.get<number>('randomPicker.maxNumber'))
    setFilters({
      excludeAbsent: settings.get<boolean>('randomPicker.excludeAbsent'),
      excludeLate: settings.get<boolean>('randomPicker.excludeLate'),
      excludeExcluded: settings.get<boolean>('randomPicker.excludeExcluded'),
    })
  }, [open])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const numberStudents = useMemo(() => {
    if (pickerMode !== 'number') return []
    const list: string[] = []
    for (let i = minNumber; i <= maxNumber; i += 1) {
      list.push(`${String(i).padStart(2, '0')}号`)
    }
    return list
  }, [pickerMode, minNumber, maxNumber])

  const filteredStudents = useMemo(() => {
    if (pickerMode === 'number') return numberStudents
    return state.students.filter((name) => {
      if (filters.excludeAbsent && absent.includes(name)) return false
      if (filters.excludeLate && late.includes(name)) return false
      if (filters.excludeExcluded && exclude.includes(name)) return false
      return true
    })
  }, [pickerMode, numberStudents, state.students, filters, absent, late, exclude])

  const maxAllowed = Math.min(10, filteredStudents.length)

  useEffect(() => {
    if (count > maxAllowed) setCount(Math.max(1, maxAllowed))
  }, [count, maxAllowed])

  const finish = useCallback(() => {
    setAnimating(false)
    const shuffled = shuffle(filteredStudents)
    setPicked(shuffled.slice(0, Math.min(count, filteredStudents.length)))
  }, [filteredStudents, count])

  const startPicking = () => {
    if (filteredStudents.length === 0) return
    setStarted(true)
    if (!settings.get<boolean>('randomPicker.animation')) {
      finish()
      return
    }
    setAnimating(true)
    setHighlighted([])
    const totalSteps = 5
    let step = 0
    const animate = () => {
      const indices: number[] = []
      const limit = Math.min(count, filteredStudents.length)
      while (indices.length < limit) {
        const index = Math.floor(Math.random() * filteredStudents.length)
        if (!indices.includes(index)) indices.push(index)
      }
      setHighlighted(indices)
      step += 1
      const nextDelay = 50 + step * 20
      if (step < totalSteps) {
        timer.current = window.setTimeout(animate, nextDelay)
      } else {
        timer.current = window.setTimeout(finish, 500)
      }
    }
    animate()
  }

  const reset = () => {
    setStarted(false)
    setAnimating(false)
    setPicked([])
    setHighlighted([])
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
  }

  const remaining = filteredStudents.filter((name) => !picked.includes(name))

  const refreshSingle = (index: number) => {
    if (remaining.length === 0) return
    const name = remaining[Math.floor(Math.random() * remaining.length)]
    setPicked((current) => current.map((item, i) => (i === index ? name : item)))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={600}
      maskClosable={false}
      fullscreenOnMobile
      title={
        <>
          <Icon name="account" size={24} className="mr-2" />
          随机点名
        </>
      }
    >
      {!started ? (
        <div className="text-center" style={{ padding: '24px 8px' }}>
          <div className="text-h6 mb-4">请选择抽取人数</div>

          <div className="d-flex justify-center align-center random-counter">
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-tonal counter-btn"
              data-color="primary"
              disabled={count <= 1}
              onClick={() => setCount((value) => Math.max(1, value - 1))}
              aria-label="减少人数"
            >
              <Icon name="minus" size={26} />
            </button>

            <div className="mx-8" style={{ minWidth: 100, textAlign: 'center' }}>
              <span className="text-h3 font-weight-bold">{count}</span>
              <span className="text-subtitle-1 ml-2">人</span>
            </div>

            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-tonal counter-btn"
              data-color="primary"
              disabled={count >= maxAllowed}
              onClick={() => setCount((value) => Math.min(maxAllowed, value + 1))}
              aria-label="增加人数"
            >
              <Icon name="plus" size={26} />
            </button>
          </div>

          <div className="mt-6 d-flex justify-center">
            <div className="v-btn-group mode-toggle">
              <button
                type="button"
                className={`v-btn ${pickerMode === 'name' ? 'v-btn--variant-flat' : 'v-btn--variant-text'}`}
                data-color={pickerMode === 'name' ? 'primary' : undefined}
                onClick={() => {
                  setPickerMode('name')
                  settings.set('randomPicker.mode', 'name')
                }}
              >
                <Icon name="account" size={18} />
                姓名模式
              </button>
              <button
                type="button"
                className={`v-btn ${pickerMode === 'number' ? 'v-btn--variant-flat' : 'v-btn--variant-text'}`}
                data-color={pickerMode === 'number' ? 'primary' : undefined}
                onClick={() => {
                  setPickerMode('number')
                  settings.set('randomPicker.mode', 'number')
                }}
              >
                <Icon name="list" size={18} />
                学号模式
              </button>
            </div>
          </div>

          {pickerMode === 'number' && (
            <div className="number-range-container mt-4">
              <div className="text-subtitle-1 mb-2">学号范围设置</div>
              <div className="d-flex justify-center align-center" style={{ gap: 16 }}>
                <input
                  className="v-field v-field--density-compact"
                  style={{ width: 100 }}
                  type="number"
                  min={1}
                  max={100}
                  value={minNumber}
                  onChange={(event) => {
                    const next = Math.max(1, Math.min(Number(event.target.value), maxNumber))
                    setMinNumber(next)
                    settings.set('randomPicker.minNumber', next)
                  }}
                  aria-label="最小值"
                />
                <span className="mx-2">至</span>
                <input
                  className="v-field v-field--density-compact"
                  style={{ width: 100 }}
                  type="number"
                  min={1}
                  max={100}
                  value={maxNumber}
                  onChange={(event) => {
                    const next = Math.max(minNumber, Math.min(Number(event.target.value), 100))
                    setMaxNumber(next)
                    settings.set('randomPicker.maxNumber', next)
                  }}
                  aria-label="最大值"
                />
              </div>
            </div>
          )}

          <div className="mt-4">
            <button
              type="button"
              className="v-btn v-btn--size-x-large v-btn--variant-flat start-btn"
              data-color="primary"
              disabled={filteredStudents.length === 0}
              onClick={startPicking}
            >
              <Icon name="shuffle" size={22} />
              开始抽取
            </button>
          </div>

          {filteredStudents.length === 0 && (
            <div className="mt-4 text-error">
              {pickerMode === 'name' ? '没有可抽取的学生，请调整过滤选项' : '请设置有效的学号范围'}
            </div>
          )}

          <div className="mt-4 text-caption">
            当前可抽取学生: {filteredStudents.length}人
            {pickerMode === 'name' && (
              <span title={[
                filters.excludeAbsent ? `已排除请假学生 (${absent.length}人)` : '',
                filters.excludeLate ? `已排除迟到学生 (${late.length}人)` : '',
                filters.excludeExcluded ? `已排除不参与学生 (${exclude.length}人)` : '',
              ].filter(Boolean).join('\n')}>
                <Icon name="info" size={16} className="ml-1" />
              </span>
            )}

            {pickerMode === 'name' && (
              <div className="d-flex flex-wrap justify-center mt-4" style={{ gap: 8 }}>
                <button
                  type="button"
                  className={`v-chip filter-chip ${filters.excludeLate ? 'v-chip--variant-elevated' : 'v-chip--variant-text'}`}
                  data-color={filters.excludeLate ? 'warning' : undefined}
                  onClick={() => setFilters((f) => ({ ...f, excludeLate: !f.excludeLate }))}
                >
                  <Icon name="clockAlert" size={16} />
                  {filters.excludeLate ? '排除' : '包含'}迟到学生
                </button>
                <button
                  type="button"
                  className={`v-chip filter-chip ${filters.excludeAbsent ? 'v-chip--variant-elevated' : 'v-chip--variant-text'}`}
                  data-color={filters.excludeAbsent ? 'error' : undefined}
                  onClick={() => setFilters((f) => ({ ...f, excludeAbsent: !f.excludeAbsent }))}
                >
                  <Icon name="users" size={16} />
                  {filters.excludeAbsent ? '排除' : '包含'}请假学生
                </button>
                <button
                  type="button"
                  className={`v-chip filter-chip ${filters.excludeExcluded ? 'v-chip--variant-elevated' : 'v-chip--variant-text'}`}
                  data-color={filters.excludeExcluded ? 'grey' : undefined}
                  onClick={() => setFilters((f) => ({ ...f, excludeExcluded: !f.excludeExcluded }))}
                >
                  <Icon name="close" size={16} />
                  {filters.excludeExcluded ? '排除' : '包含'}不参与学生
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center" style={{ padding: '24px 8px' }}>
          {animating ? (
            <div className="random-animation">
              <div className="random-shuffle">
                {filteredStudents.map((name, index) => (
                  <div
                    key={`${name}-${index}`}
                    className={`random-student ${highlighted.includes(index) ? 'highlighted' : ''}`}
                  >
                    {name}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ minHeight: 300 }}>
              <div className="text-h6 mb-4">抽取结果</div>
              {picked.map((name, index) => (
                <div className="v-card v-card--variant-outlined result-card mb-2" key={`${name}-${index}`}>
                  <div className="v-card-text text-h4 text-center py-4 d-flex align-center justify-center">
                    {name}
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text ml-2"
                      disabled={remaining.length === 0}
                      title={remaining.length === 0 ? '没有更多可用学生' : '重新抽取此学生'}
                      onClick={() => refreshSingle(index)}
                    >
                      <Icon name="refresh" size={18} />
                    </button>
                  </div>
                </div>
              ))}

              <div className="mt-6 d-flex justify-center flex-wrap" style={{ gap: 8 }}>
                <button
                  type="button"
                  className="v-btn v-btn--size-large v-btn--variant-flat"
                  data-color="primary"
                  onClick={reset}
                >
                  <Icon name="refresh" size={20} />
                  重新抽取
                </button>
                <button
                  type="button"
                  className="v-btn v-btn--size-large v-btn--variant-outlined"
                  onClick={onClose}
                >
                  关闭
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}

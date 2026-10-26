import { useEffect, useMemo, useState } from 'react'
import { MdiIcon } from './MdiIcon'
import { Modal } from './ui/Modal'
import { toDateKey } from '../lib/date'
import { useAppState, useMediaQuery, useSetting } from '../lib/hooks'
import { attendanceStats, store, type AttendanceKind } from '../lib/store'

/** 历史看板可能保留已从花名册删除的姓名，展示时按当前名单过滤 */
function visibleAttendance(students: string[], attendance: { absent: string[]; late: string[]; exclude: string[] }) {
  const names = new Set(students)
  return {
    absent: attendance.absent.filter((name) => names.has(name)),
    late: attendance.late.filter((name) => names.has(name)),
    exclude: attendance.exclude.filter((name) => names.has(name)),
  }
}

export function useAttendanceSummary() {
  const state = useAppState()
  const [lateCounts] = useSetting<boolean>('display.lateStudentsArePresent')
  return useMemo(
    () => attendanceStats(state.board, state.students),
    [state.board, state.students, lateCounts],
  )
}

/** 右侧出勤栏：对齐 AttendanceSidebar.vue（“出勤 / 应到 / 实到 / 请假…”） */
export function AttendanceSidebar({ onOpen }: { onOpen: () => void }) {
  const state = useAppState()
  const stats = useAttendanceSummary()
  const { absent, late, exclude } = visibleAttendance(state.students, state.board.attendance)
  const lgAndUp = useMediaQuery('(min-width: 1280px)')

  return (
    <aside className="attendance-area no-select" onClick={onOpen}>
      <h1>出勤</h1>
      <h2>
        <span style={{ whiteSpace: 'nowrap' }}>应到</span> :{' '}
        <span style={{ whiteSpace: 'nowrap' }}>{stats.expected}人</span>
      </h2>
      <h2>
        <span style={{ whiteSpace: 'nowrap' }}>实到</span> :{' '}
        <span style={{ whiteSpace: 'nowrap' }}>{stats.present}人</span>
      </h2>
      <h2>
        <span style={{ whiteSpace: 'nowrap' }}>请假</span> :{' '}
        <span style={{ whiteSpace: 'nowrap' }}>{absent.length}人</span>
      </h2>
      {absent.map((name, index) => (
        <h3 key={`absent-${name}`} className="gray-text">
          {lgAndUp && <span>{index + 1}. </span>}
          <span style={{ whiteSpace: 'nowrap' }}>{name}</span>
        </h3>
      ))}
      <h2>
        <span style={{ whiteSpace: 'nowrap' }}>迟到</span> :{' '}
        <span style={{ whiteSpace: 'nowrap' }}>{late.length}人</span>
      </h2>
      {late.map((name, index) => (
        <h3 key={`late-${name}`} className="gray-text">
          {lgAndUp && <span>{index + 1}. </span>}
          <span style={{ whiteSpace: 'nowrap' }}>{name}</span>
        </h3>
      ))}
      <h2>
        <span style={{ whiteSpace: 'nowrap' }}>不参与</span> :{' '}
        <span style={{ whiteSpace: 'nowrap' }}>{exclude.length}人</span>
      </h2>
      {exclude.map((name, index) => (
        <h3 key={`exclude-${name}`} className="gray-text">
          {lgAndUp && <span>{index + 1}. </span>}
          <span style={{ whiteSpace: 'nowrap' }}>{name}</span>
        </h3>
      ))}
    </aside>
  )
}

/** 移动端出勤卡片：对齐 HomeworkGrid.vue 中的 attendance 卡片 */
export function AttendanceCard({ onOpen }: { onOpen: () => void }) {
  const state = useAppState()
  const stats = useAttendanceSummary()
  const { absent, late, exclude } = visibleAttendance(state.students, state.board.attendance)

  return (
    <article
      className="v-card border rounded-xl glow-track cursor-pointer"
      onClick={onOpen}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        event.currentTarget.style.setProperty(
          '--x',
          `${((event.clientX - rect.left) / rect.width) * 100}%`,
        )
        event.currentTarget.style.setProperty(
          '--y',
          `${((event.clientY - rect.top) / rect.height) * 100}%`,
        )
      }}
      onTouchMove={(event) => {
        if (event.touches.length !== 1) return
        const touch = event.touches[0]
        const rect = event.currentTarget.getBoundingClientRect()
        event.currentTarget.style.setProperty(
          '--x',
          `${((touch.clientX - rect.left) / rect.width) * 100}%`,
        )
        event.currentTarget.style.setProperty(
          '--y',
          `${((touch.clientY - rect.top) / rect.height) * 100}%`,
        )
      }}
    >
      <div className="v-card-title">
        <MdiIcon name="account-group" size={20} className="text-primary mr-2" />
        出勤统计
      </div>
      <div className="v-card-text">
        <div className="d-flex justify-space-between align-center mb-2">
          <span>应到/实到</span>
          <span className="text-h6">
            {stats.expected}/{stats.present}
          </span>
        </div>
        <hr className="v-divider mb-2" />

        {absent.length > 0 && (
          <div className="mb-2">
            <div className="text-error text-caption mb-1">请假 ({absent.length})</div>
            <div className="d-flex flex-wrap" style={{ gap: 4 }}>
              {absent.map((name) => (
                <span key={name} className="v-chip v-chip--size-x-small v-chip--variant-flat" data-color="error">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}

        {late.length > 0 && (
          <div className="mb-2">
            <div className="text-warning text-caption mb-1">迟到 ({late.length})</div>
            <div className="d-flex flex-wrap" style={{ gap: 4 }}>
              {late.map((name) => (
                <span key={name} className="v-chip v-chip--size-x-small v-chip--variant-flat" data-color="warning">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}

        {exclude.length > 0 && (
          <div className="mb-2">
            <div className="text-grey text-caption mb-1">不参与 ({exclude.length})</div>
            <div className="d-flex flex-wrap" style={{ gap: 4 }}>
              {exclude.map((name) => (
                <span key={name} className="v-chip v-chip--size-x-small v-chip--variant-flat" data-color="grey">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}

        {absent.length === 0 && late.length === 0 && exclude.length === 0 && (
          <div className="text-success text-center mt-2">全勤</div>
        )}
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ */

/** 状态过滤项：对齐 AttendanceManagementDialog.vue 的 filter chips */
const STATUS_FILTERS = [
  { value: 'present', label: '到课', color: 'success', icon: 'account-check' },
  { value: 'absent', label: '请假', color: 'error', icon: 'account-off' },
  { value: 'late', label: '迟到', color: 'warning', icon: 'clock-alert' },
  { value: 'exclude', label: '不参与', color: 'grey', icon: 'account-cancel' },
] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]['value']

const statusMeta: Record<StatusFilter, { color: string; icon: string }> = {
  present: { color: 'success', icon: 'account-check' },
  absent: { color: 'error', icon: 'account-off' },
  late: { color: 'warning', icon: 'clock-alert' },
  exclude: { color: 'grey', icon: 'account-cancel' },
}

/** 考勤登记对话框：对齐 AttendanceManagementDialog.vue（搜索 + 姓氏筛选 + 过滤器 + 卡片网格 + 批量操作） */
export function AttendanceDialog({
  open,
  onClose,
  canEdit,
  onBlocked,
}: {
  open: boolean
  onClose: () => void
  canEdit: boolean
  onBlocked: () => void
}) {
  const state = useAppState()
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<StatusFilter[]>([])
  const isMobile = useMediaQuery('(max-width: 599px)')
  const { absent, late, exclude } = state.board.attendance

  useEffect(() => {
    if (open) {
      setQuery('')
      setFilters([])
    }
  }, [open])

  const statusOf = (name: string): StatusFilter =>
    absent.includes(name) ? 'absent' : late.includes(name) ? 'late' : exclude.includes(name) ? 'exclude' : 'present'

  /** 与上游一致：按搜索词 + 姓氏 + 状态过滤 */
  const filtered = useMemo(() => {
    let students = state.students
    const q = query.trim().toLowerCase()
    if (q) students = students.filter((name) => name.toLowerCase().includes(q))
    if (filters.length > 0) {
      students = students.filter((name) => filters.includes(statusOf(name)))
    }
    return students
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters, state.students, absent, late, exclude])

  /** 姓氏统计：对齐 extractedSurnames（按拼音序） */
  const surnames = useMemo(() => {
    const map = new Map<string, number>()
    for (const name of state.students) {
      if (!name) continue
      map.set(name.charAt(0), (map.get(name.charAt(0)) ?? 0) + 1)
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }, [state.students])

  const toggleFilter = (value: StatusFilter) => {
    setFilters((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    )
  }

  /** 设置单个学生状态：present 表示从所有名单移除 */
  const setStatus = (name: string, target: StatusFilter) => {
    if (!canEdit) {
      onBlocked()
      return
    }
    if (target === 'present') {
      for (const kind of ['absent', 'late', 'exclude'] as AttendanceKind[]) {
        if (state.board.attendance[kind].includes(name)) store.toggleAttendance(name, kind)
      }
      return
    }
    if (!state.board.attendance[target].includes(name)) store.toggleAttendance(name, target)
  }

  const setAll = (target: StatusFilter) => {
    if (!canEdit) {
      onBlocked()
      return
    }
    if (target === 'present') {
      store.clearAttendance()
      return
    }
    store.setAttendance(target, state.students)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="d-flex align-center w-full">
          <MdiIcon name="account-group" size={24} className="mr-2" />
          考勤
          {!isMobile && (
            <span className="v-chip v-chip--size-small v-chip--variant-tonal ml-2" data-color="primary">
              {toDateKey(state.date)}
            </span>
          )}
        </span>
      }
      width={900}
      fullscreenOnMobile
      footer={
        <>
          <hr className="v-divider" style={{ margin: '0 0 8px' }} />
          <div className="flex-grow-1" />
          <button
            type="button"
            className="v-btn"
            data-color="primary"
            onClick={async () => {
              const saved = await store.save({ silent: true })
              if (saved) onClose()
            }}
          >
            <MdiIcon name="content-save" size={18} />
            保存
          </button>
        </>
      }
    >
      {/* 搜索 + 姓氏筛选 */}
      <div className="mb-4">
        <div className="v-field">
          <MdiIcon
            name="magnify"
            size={20}
            className="pointer-events-none mr-2"
            style={{ color: 'rgba(var(--v-theme-on-surface), 0.5)' }}
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索学生"
            aria-label="搜索学生"
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
            }}
          />
          {query && (
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text"
              style={{ width: 28, height: 28, minWidth: 28 }}
              onClick={() => setQuery('')}
              aria-label="清空搜索"
            >
              <MdiIcon name="close" size={18} />
            </button>
          )}
        </div>
        <div className="text-caption" style={{ opacity: 0.7, marginTop: 2 }}>
          支持筛选姓氏，如输入&apos;孙&apos;可筛选所有姓孙的学生
        </div>
        {surnames.length > 0 && (
          <div className="d-flex flex-wrap mt-2" style={{ gap: 4 }}>
            {surnames.map((surname) => {
              const active = query === surname.name
              return (
                <button
                  key={surname.name}
                  type="button"
                  className={`v-btn ${active ? 'v-btn--variant-elevated' : 'v-btn--variant-text'}`}
                  data-color={active ? 'primary' : undefined}
                  onClick={() => setQuery(active ? '' : surname.name)}
                >
                  {surname.name} ({surname.count})
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 状态过滤器 */}
      <div className="d-flex flex-wrap mb-4" style={{ gap: 8 }}>
        {STATUS_FILTERS.map((item) => {
          const active = filters.includes(item.value)
          return (
            <button
              key={item.value}
              type="button"
              className={`v-chip filter-chip px-2 v-chip--variant-${active ? 'elevated' : 'tonal'}`}
              data-color={item.color}
              onClick={() => toggleFilter(item.value)}
            >
              <MdiIcon name={item.icon} size={18} />
              {item.label}
              {active && <MdiIcon name="check" size={18} />}
            </button>
          )
        })}
      </div>

      {/* 学生列表 */}
      <div className="attendance-student-grid">
        {filtered.map((name) => {
          const status = statusOf(name)
          const meta = statusMeta[status]
          const iconBtnClass = `v-btn v-btn--icon v-btn--variant-text ${
            isMobile ? '' : 'v-btn--size-small'
          }`
          return (
            <div key={name} className="v-card border student-card">
              <div className="d-flex align-center" style={{ padding: 8 }}>
                <span
                  className="v-avatar mr-2"
                  data-color={meta.color}
                  style={{ width: 24, height: 24 }}
                >
                  <MdiIcon name={meta.icon} size={16} />
                </span>
                <span
                  className="text-subtitle-1 flex-grow-1"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {name}
                </span>
                <div className="d-flex attendance-actions">
                  {STATUS_FILTERS.map((item) => {
                    const active = status === item.value
                    return (
                      <button
                        key={item.value}
                        type="button"
                        className={iconBtnClass}
                        data-color={active ? item.color : undefined}
                        title={`设为${item.label}`}
                        onClick={() => setStatus(name, item.value)}
                      >
                        <MdiIcon name={item.icon} size={18} />
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 批量操作 */}
      <div
        className="v-card v-card--variant-tonal mt-4 mb-4"
        data-color="primary"
      >
        <div style={{ padding: 16 }}>
          <div className="text-subtitle-2 mb-2">批量操作</div>
          <div className="d-flex flex-wrap" style={{ gap: 8 }}>
            {STATUS_FILTERS.map((item) => (
              <button
                key={item.value}
                type="button"
                className="v-btn flex-grow-1"
                data-color={item.color}
                onClick={() => setAll(item.value)}
              >
                <MdiIcon name={item.icon} size={18} />
                {item.value === 'present' ? '全部到齐' : `全部${item.label}`}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

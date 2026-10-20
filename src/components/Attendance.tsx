import { useMemo, useState } from 'react'
import { MdiIcon } from './MdiIcon'
import { Modal } from './ui/Modal'
import { useAppState, useMediaQuery, useSetting } from '../lib/hooks'
import { attendanceStats, store, type AttendanceKind } from '../lib/store'
import { toast } from '../lib/toast'

const KIND_META: Record<AttendanceKind, { label: string; color: string; bg: string }> = {
  absent: { label: '请假', color: 'rgb(var(--v-theme-error))', bg: 'rgba(var(--v-theme-error), 0.12)' },
  late: { label: '迟到', color: 'rgb(var(--v-theme-warning))', bg: 'rgba(var(--v-theme-warning), 0.12)' },
  exclude: { label: '不参与', color: 'rgb(var(--v-theme-grey))', bg: 'rgba(var(--v-theme-surface-variant), 0.5)' },
}

export function useAttendanceSummary() {
  const state = useAppState()
  const [lateCounts] = useSetting<boolean>('display.lateStudentsArePresent')
  return useMemo(
    () => attendanceStats(state.board, state.students.length),
    [state.board, state.students.length, lateCounts],
  )
}

/** 右侧出勤栏：对齐 AttendanceSidebar.vue（“出勤 / 应到 / 实到 / 请假…”） */
export function AttendanceSidebar({ onOpen }: { onOpen: () => void }) {
  const state = useAppState()
  const stats = useAttendanceSummary()
  const { absent, late, exclude } = state.board.attendance
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
  const { absent, late, exclude } = state.board.attendance

  return (
    <article className="v-card border rounded-xl glow-track cursor-pointer" onClick={onOpen}>
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
  const { absent, late, exclude } = state.board.attendance

  const statusOf = (name: string): AttendanceKind | 'present' =>
    absent.includes(name) ? 'absent' : late.includes(name) ? 'late' : exclude.includes(name) ? 'exclude' : 'present'

  const filtered = useMemo(() => {
    const q = query.trim()
    return q ? state.students.filter((name) => name.includes(q)) : state.students
  }, [query, state.students])

  const toggle = (name: string, kind: AttendanceKind) => {
    if (!canEdit) {
      onBlocked()
      return
    }
    store.toggleAttendance(name, kind)
  }

  const bulk = async (kind: AttendanceKind | 'reset') => {
    if (!canEdit) {
      onBlocked()
      return
    }
    if (kind === 'reset') {
      store.clearAttendance()
      toast.success('已重置', '全员出席')
      return
    }
    store.setAttendance(kind, state.students)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="登记出勤"
      subtitle={`共 ${state.students.length} 人 · 点击姓名右侧按钮标记状态，再次点击取消`}
      width={620}
      fullscreenOnMobile
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void bulk('reset')}
            disabled={!canEdit}
          >
            全部出席
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              await store.save({ silent: true })
              onClose()
            }}
          >
            完成
          </button>
        </>
      }
    >
      <div className="sticky top-0 z-10 -mx-1 px-1 pb-2" style={{ background: 'var(--surface)' }}>
        <div className="relative">
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: 'var(--text-3)' }}
          >
            <MdiIcon name="magnify" size={15} />
          </span>
          <input
            className="field pl-9"
            placeholder="搜索学生姓名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(Object.keys(KIND_META) as AttendanceKind[]).map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void bulk(kind)}
              disabled={!canEdit}
            >
              全员{KIND_META[kind].label}
            </button>
          ))}
        </div>
      </div>

      <ul className="m-0 list-none divide-y p-0" style={{ borderColor: 'var(--border)' }}>
        {filtered.map((name) => {
          const status = statusOf(name)
          return (
            <li
              key={name}
              className="flex items-center gap-2 py-2"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <span className="min-w-0 flex-1 truncate text-[14px]">{name}</span>
              <div className="flex shrink-0 gap-1">
                {(Object.keys(KIND_META) as AttendanceKind[]).map((kind) => {
                  const active = status === kind
                  const meta = KIND_META[kind]
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => toggle(name, kind)}
                      className="rounded-[8px] px-2 py-1 text-[12px] font-medium transition-colors"
                      style={
                        active
                          ? { background: meta.bg, color: meta.color, boxShadow: `inset 0 0 0 1px ${meta.color}` }
                          : { background: 'var(--surface-2)', color: 'var(--text-3)' }
                      }
                    >
                      {meta.label}
                    </button>
                  )
                })}
              </div>
            </li>
          )
        })}
        {filtered.length === 0 && (
          <li className="py-10 text-center text-[13px]" style={{ color: 'var(--text-3)' }}>
            未找到学生
          </li>
        )}
      </ul>
    </Modal>
  )
}

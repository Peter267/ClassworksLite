import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/ui/Modal'
import { shortDate, isSameDay, toISODate, today } from '../lib/date'
import { useAppState, useSetting } from '../lib/hooks'
import { store } from '../lib/store'
import { toast } from '../lib/toast'
import type { ExamConfig, ExamSubjectEntry } from '../lib/types'

function emptyEntry(): ExamSubjectEntry {
  return { name: '', date: toISODate(today()), start: '', end: '', room: '' }
}

function newExam(): ExamConfig {
  return {
    id: `exam-${Date.now()}`,
    examName: '',
    subjects: [emptyEntry()],
    note: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function formatRange(exam: ExamConfig): string {
  const dates = exam.subjects.map((s) => s.date).filter(Boolean).sort()
  if (dates.length === 0) return '未设置日期'
  const first = dates[0]
  const last = dates[dates.length - 1]
  return first === last ? first : `${first} → ${last}`
}

export function ExamBoard({ onBack }: { onBack: () => void }) {
  const state = useAppState()
  const [blockPast] = useSetting<boolean>('edit.blockPastDataEdit')
  const [editing, setEditing] = useState<ExamConfig | null>(null)
  // 固定/移出看板写的是当前日期的作业板，历史日期同样受「禁止编辑历史」约束（F6）
  const boardLocked = blockPast && !isSameDay(state.date, today())

  const upcoming = useMemo(() => {
    const todayIso = toISODate(today())
    return state.exams.filter((exam) => exam.subjects.some((s) => s.date >= todayIso))
  }, [state.exams])

  const past = useMemo(() => {
    const todayIso = toISODate(today())
    return state.exams.filter((exam) => exam.subjects.every((s) => s.date < todayIso))
  }, [state.exams])

  return (
    <div className="mx-auto w-full max-w-[1000px] px-4 pt-[calc(var(--appbar-h)+24px)] pb-28 sm:px-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-[20px] font-semibold tracking-tight">考试看板</h2>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--text-3)' }}>
            共 {state.exams.length} 场 · 可把任意一场作为卡片固定到作业板上
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing(newExam())}>
          <Icon name="plus" size={15} />
          新建考试
        </button>
      </div>

      {state.exams.length === 0 && (
        <div className="card flex flex-col items-center gap-3 px-6 py-16 text-center">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-full"
            style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }}
          >
            <Icon name="calendar" size={22} />
          </span>
          <div className="text-[15px] font-semibold">还没有考试安排</div>
          <p className="m-0 max-w-[360px] text-[13px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            创建一场考试并填写各科时间，就能在作业板上以卡片形式展示倒计时与考场信息。
          </p>
          <button type="button" className="btn btn-tonal" onClick={() => setEditing(newExam())}>
            <Icon name="plus" size={15} />
            创建第一场考试
          </button>
        </div>
      )}

      {[
        { label: '即将开始', items: upcoming },
        { label: '已结束', items: past },
      ].map((group) =>
        group.items.length === 0 ? null : (
          <section key={group.label} className="mb-6">
            <h3
              className="mb-2.5 text-[12.5px] font-semibold tracking-wide"
              style={{ color: 'var(--text-3)' }}
            >
              {group.label}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.items.map((exam) => {
                const added = Boolean(state.board.homework[`exam-${exam.id}`])
                return (
                  <article key={exam.id} className="card p-5">
                    <header className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="m-0 truncate text-[16px] font-semibold tracking-tight">
                          {exam.examName || '未命名考试'}
                        </h4>
                        <p className="m-0 mt-1 text-[12px]" style={{ color: 'var(--text-3)' }}>
                          {formatRange(exam)} · {exam.subjects.length} 个科目
                        </p>
                      </div>
                      <span className={`chip ${added ? 'chip-success' : ''}`}>
                        {added ? '已上板' : '未上板'}
                      </span>
                    </header>

                    <ul className="m-0 mt-3 list-none space-y-1 p-0">
                      {exam.subjects.slice(0, 6).map((subject, index) => (
                        <li
                          key={`${subject.name}-${index}`}
                          className="flex items-center justify-between gap-2 text-[13px]"
                        >
                          <span className="truncate">{subject.name || '未命名科目'}</span>
                          <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-3)' }}>
                            {subject.date.slice(5)} {subject.start || ''}
                            {subject.room ? ` · ${subject.room}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>

                    <div className="mt-4 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className={`btn btn-sm ${added ? 'btn-outline' : 'btn-tonal'}`}
                        onClick={() => {
                          if (boardLocked) {
                            toast.warning('无法修改', '设置中已禁止编辑历史数据')
                            return
                          }
                          const nowAdded = store.addExamCard(exam.id)
                          toast.success(nowAdded ? '已添加到作业板' : '已从作业板移除', exam.examName)
                        }}
                      >
                        <Icon name={added ? 'close' : 'plus'} size={13} />
                        {added ? '移出看板' : '固定到看板'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setEditing(exam)}
                      >
                        <Icon name="edit" size={13} />
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ color: 'var(--error)' }}
                        onClick={async () => {
                          await store.deleteExam(exam.id)
                          if (state.board.homework[`exam-${exam.id}`]) store.addExamCard(exam.id)
                        }}
                      >
                        <Icon name="trash" size={13} />
                        删除
                      </button>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ),
      )}

      <div className="pt-2 text-center">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <Icon name="arrowLeft" size={14} />
          返回作业板
        </button>
      </div>

      <ExamEditor key={editing?.id ?? 'closed'} exam={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function ExamEditor({ exam, onClose }: { exam: ExamConfig | null; onClose: () => void }) {
  const [draft, setDraft] = useState<ExamConfig | null>(exam)

  const update = (patch: Partial<ExamConfig>) => {
    if (!draft) return
    setDraft({ ...draft, ...patch })
  }

  const updateEntry = (index: number, patch: Partial<ExamSubjectEntry>) => {
    if (!draft) return
    const subjects = draft.subjects.map((item, i) => (i === index ? { ...item, ...patch } : item))
    update({ subjects })
  }

  return (
    <Modal
      open={Boolean(exam && draft)}
      onClose={onClose}
      title={exam && exam.examName ? '编辑考试' : '新建考试'}
      width={640}
      fullscreenOnMobile
      footer={
        <>
          <div className="flex-1" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              if (!draft) return
              const name = draft.examName.trim()
              if (!name) {
                toast.warning('请填写考试名称', '')
                return
              }
              const subjects = draft.subjects.filter((item) => item.name.trim())
              if (subjects.length === 0) {
                toast.warning('至少填写一个科目', '')
                return
              }
              await store.saveExam({ ...draft, examName: name, subjects, updatedAt: Date.now() })
              onClose()
            }}
          >
            保存
          </button>
        </>
      }
    >
      {draft && (
        <div className="space-y-4 pb-2">
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--text-2)' }}>
              考试名称
            </span>
            <input
              className="field"
              placeholder="例如：2026 届高三第一次模拟考试"
              value={draft.examName}
              onChange={(event) => update({ examName: event.target.value })}
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12.5px] font-medium" style={{ color: 'var(--text-2)' }}>
                科目安排
              </span>
              <button
                type="button"
                className="btn btn-tonal btn-sm"
                onClick={() => update({ subjects: [...draft.subjects, emptyEntry()] })}
              >
                <Icon name="plus" size={13} />
                添加科目
              </button>
            </div>

            <div className="space-y-2">
              {draft.subjects.map((subject, index) => (
                <div
                  key={index}
                  className="grid grid-cols-2 gap-2 rounded-[14px] p-3 sm:grid-cols-[1fr_132px_84px_84px_auto]"
                  style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
                >
                  <input
                    className="field col-span-2 sm:col-span-1"
                    placeholder="科目"
                    value={subject.name}
                    onChange={(event) => updateEntry(index, { name: event.target.value })}
                  />
                  <input
                    type="date"
                    className="field"
                    value={subject.date}
                    onChange={(event) => updateEntry(index, { date: event.target.value })}
                  />
                  <input
                    type="time"
                    className="field"
                    value={subject.start ?? ''}
                    onChange={(event) => updateEntry(index, { start: event.target.value })}
                  />
                  <input
                    type="time"
                    className="field"
                    value={subject.end ?? ''}
                    onChange={(event) => updateEntry(index, { end: event.target.value })}
                  />
                  <div className="col-span-2 flex gap-2 sm:col-span-1">
                    <input
                      className="field"
                      placeholder="考场"
                      value={subject.room ?? ''}
                      onChange={(event) => updateEntry(index, { room: event.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon shrink-0"
                      style={{ color: 'var(--error)' }}
                      onClick={() =>
                        update({ subjects: draft.subjects.filter((_, i) => i !== index) })
                      }
                      aria-label="删除该科目"
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--text-2)' }}>
              备注
            </span>
            <textarea
              className="field"
              rows={2}
              placeholder="选填，例如考试范围、注意事项"
              value={draft.note ?? ''}
              onChange={(event) => update({ note: event.target.value })}
            />
          </label>

          <p className="m-0 text-[12px]" style={{ color: 'var(--text-3)' }}>
            提示：保存后可点击「固定到看板」，该考试会以卡片形式出现在 {shortDate(today())} 的作业板上。
          </p>
        </div>
      )}
    </Modal>
  )
}

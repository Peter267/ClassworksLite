import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { useAppState } from '../lib/hooks'
import { store } from '../lib/store'
import { toast } from '../lib/toast'

/** 解析粘贴文本：支持换行、制表符、逗号、顿号分隔，自动去序号与空行 */
export function parseNames(raw: string): string[] {
  return raw
    .split(/[\n\r\t,，、;；]+/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\d+[.、)\s]+/, '').trim())
    .filter((line) => line.length > 0 && line.length <= 24)
}

export function StudentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useAppState()
  const [mode, setMode] = useState<'list' | 'bulk'>('list')
  const [draft, setDraft] = useState('')
  const [bulkText, setBulkText] = useState('')
  const [query, setQuery] = useState('')
  /** 打开批量编辑时的名单基准，用于合并「批量文本之外的增删」（D6） */
  const bulkBase = useRef<string[]>([])

  useEffect(() => {
    if (open) {
      setBulkText(state.students.join('\n'))
      bulkBase.current = state.students
      setDraft('')
      setQuery('')
      setMode('list')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const enterBulk = () => {
    // 进入批量编辑时用当前最新名单初始化，避免用打开弹窗时的旧文本覆盖刚做的增删
    bulkBase.current = state.students
    setBulkText(state.students.join('\n'))
    setMode('bulk')
  }

  const filtered = useMemo(
    () => (query ? state.students.filter((name) => name.includes(query)) : state.students),
    [state.students, query],
  )

  const add = () => {
    const names = parseNames(draft)
    if (names.length === 0) return
    void store.addStudents(names)
    setDraft('')
  }

  const remove = (name: string) => {
    void store.removeStudent(name)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="学生名单"
      subtitle={`共 ${state.students.length} 人 · 名单会同步到出勤统计与随机点名`}
      width={620}
      fullscreenOnMobile
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => (mode === 'list' ? enterBulk() : setMode('list'))}
          >
            <Icon name="edit" size={14} />
            {mode === 'list' ? '批量编辑' : '返回列表'}
          </button>
          <div className="flex-1" />
          {mode === 'bulk' ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                void (async () => {
                  const names = parseNames(bulkText)
                  if (names.length === 0) {
                    toast.warning('名单为空', '至少保留一位学生')
                    return
                  }
                  // 只应用批量文本相对基准的增删，保留弹窗内其它入口刚做的修改
                  const base = bulkBase.current
                  const current = state.students
                  const removed = new Set(base.filter((name) => !names.includes(name)))
                  const merged = current.filter((name) => !removed.has(name))
                  for (const name of names) {
                    if (!merged.includes(name)) merged.push(name)
                  }
                  if (merged.length === 0) {
                    toast.warning('名单为空', '至少保留一位学生')
                    return
                  }
                  const saved = await store.setStudents(merged)
                  if (!saved) return
                  bulkBase.current = merged
                  setMode('list')
                  toast.success('已保存', `共 ${merged.length} 人`)
                })()
              }}
            >
              保存名单
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          )}
        </>
      }
    >
      {mode === 'list' ? (
        <>
          <div className="flex gap-2">
            <input
              className="field"
              placeholder="输入姓名后回车添加，支持一次粘贴多个"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  add()
                }
              }}
            />
            <button type="button" className="btn btn-tonal shrink-0" onClick={add}>
              <Icon name="plus" size={15} />
              添加
            </button>
          </div>

          {state.students.length > 8 && (
            <div className="relative mt-3">
              <span
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-3)' }}
              >
                <Icon name="search" size={15} />
              </span>
              <input
                className="field pl-9"
                placeholder="搜索"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-1.5 pb-2">
            {filtered.map((name) => (
              <span
                key={name}
                className="group inline-flex items-center gap-1 rounded-[10px] py-1 pl-2.5 pr-1.5 text-[13px]"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }}
              >
                {name}
                <button
                  type="button"
                  className="rounded p-0.5 transition-colors hover:bg-[var(--surface-3)]"
                  style={{ color: 'var(--text-3)' }}
                  onClick={() => remove(name)}
                  aria-label={`删除 ${name}`}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            {filtered.length === 0 && (
              <div className="py-6 text-center text-[13px] w-full" style={{ color: 'var(--text-3)' }}>
                没有匹配的学生
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 mb-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
            每行一个姓名，也可以直接从 Excel 复制整列粘贴进来。行首序号会被自动去掉。
          </p>
          <textarea
            className="field"
            style={{ minHeight: 320, fontFamily: 'var(--font-mono)', fontSize: 13.5, lineHeight: 1.8 }}
            value={bulkText}
            onChange={(event) => setBulkText(event.target.value)}
            placeholder={'张三\n李四\n王五'}
          />
          <div className="mt-2 text-right text-[12px] tabular-nums" style={{ color: 'var(--text-3)' }}>
            解析到 {parseNames(bulkText).length} 人
          </div>
        </>
      )}
    </Modal>
  )
}

interface SubjectDraft {
  /** 稳定 key：改名时输入框不会因 key 变化而重建 */
  id: string
  name: string
  /** 打开弹窗时的名字，用于明确计算改名映射，而不是按数组位置猜测 */
  originalName?: string
}

let subjectSeq = 0
function nextSubjectId() {
  subjectSeq += 1
  return `subject-${subjectSeq}`
}

export function SubjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useAppState()
  const [items, setItems] = useState<SubjectDraft[]>([])
  const [draft, setDraft] = useState('')
  const originalNames = useRef<string[]>([])

  useEffect(() => {
    if (open) {
      originalNames.current = state.subjects.map((subject) => subject.name)
      setItems(
        state.subjects.map((subject) => ({
          id: nextSubjectId(),
          name: subject.name,
          originalName: subject.name,
        })),
      )
      setDraft('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const move = (index: number, delta: number) => {
    const next = [...items]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    setItems(next)
  }

  const remove = (id: string) => {
    if (items.length <= 1) {
      toast.warning('至少保留一个科目', '')
      return
    }
    setItems(items.filter((item) => item.id !== id))
  }

  const add = () => {
    const name = draft.trim()
    if (!name) return
    if (items.some((item) => item.name.trim() === name)) {
      toast.warning('科目已存在', name)
      return
    }
    setItems([...items, { id: nextSubjectId(), name }])
    setDraft('')
  }

  const persist = async () => {
    const clean = items.map((item) => ({ ...item, name: item.name.trim() }))
    if (clean.some((item) => !item.name)) {
      toast.warning('科目名称不能为空', '请填写或删除空行')
      return
    }
    const names = clean.map((item) => item.name)
    const duplicated = names.filter((name, index) => names.indexOf(name) !== index)
    if (duplicated.length > 0) {
      toast.warning('科目名称重复', [...new Set(duplicated)].join('、'))
      return
    }

    const original = new Set(originalNames.current)
    const renames: { from: string; to: string }[] = []
    for (const item of clean) {
      if (!item.originalName || item.originalName === item.name) continue
      // 旧名仍被其他科目使用，或目标名原本属于另一个科目：无法安全推断改名/合并
      if (names.includes(item.originalName) || original.has(item.name)) {
        toast.warning(
          '无法自动迁移历史作业',
          `“${item.originalName}”与“${item.name}”存在名称交叉，请分步改名`,
        )
        return
      }
      renames.push({ from: item.originalName, to: item.name })
    }

    const result = await store.setSubjects(
      clean.map((item, index) => ({ name: item.name, order: index })),
      { renames },
    )
    if (!result.saved) return

    toast.success(
      '已保存',
      result.renamed > 0
        ? `共 ${clean.length} 个科目，已迁移 ${result.renamed} 个日期的作业`
        : `共 ${clean.length} 个科目`,
    )
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="科目管理"
      subtitle="科目决定作业卡片的顺序与空卡片提示"
      width={520}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <div className="flex-1" />
          <button type="button" className="btn btn-primary" onClick={() => void persist()}>
            保存
          </button>
        </>
      }
    >
      <div className="flex gap-2">
        <input
          className="field"
          placeholder="新增科目名称"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <button type="button" className="btn btn-tonal shrink-0" onClick={add}>
          <Icon name="plus" size={15} />
        </button>
      </div>

      <ul className="m-0 mt-4 list-none p-0 pb-2">
        {items.map((item, index) => (
          <li
            key={item.id}
            className="flex items-center gap-2 py-1.5"
            style={{ borderTop: index === 0 ? 'none' : '1px solid var(--border)' }}
          >
            <span
              className="w-6 text-center text-[12px] tabular-nums"
              style={{ color: 'var(--text-3)' }}
            >
              {index + 1}
            </span>
            <input
              className="flex-1 bg-transparent text-[14px] outline-none"
              value={item.name}
              onChange={(event) => {
                const next = [...items]
                next[index] = { ...next[index], name: event.target.value }
                setItems(next)
              }}
            />
            <button
              type="button"
              className="rounded p-1 disabled:opacity-30"
              style={{ color: 'var(--text-3)' }}
              onClick={() => move(index, -1)}
              disabled={index === 0}
              aria-label="上移"
            >
              <Icon name="up" size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1 disabled:opacity-30"
              style={{ color: 'var(--text-3)' }}
              onClick={() => move(index, 1)}
              disabled={index === items.length - 1}
              aria-label="下移"
            >
              <Icon name="down" size={14} />
            </button>
            <button
              type="button"
              className="rounded p-1"
              style={{ color: 'var(--error)' }}
              onClick={() => remove(item.id)}
              aria-label="删除"
            >
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

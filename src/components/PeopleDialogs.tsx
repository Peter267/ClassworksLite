import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { MdiIcon } from './MdiIcon'
import { Modal } from './ui/Modal'
import { useAppState, useMediaQuery } from '../lib/hooks'
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
  /** 草稿名单：与上游一致，改动不落库，点「保存名单」才提交 */
  const [list, setList] = useState<string[]>([])
  const [text, setText] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [newName, setNewName] = useState('')
  const [editIndex, setEditIndex] = useState(-1)
  const [editName, setEditName] = useState('')
  const [menuIndex, setMenuIndex] = useState(-1)
  const savedList = useRef<string[]>([])
  const isMobile = useMediaQuery('(max-width: 959px)')

  const pinyinCollator = useMemo(() => {
    try {
      return new Intl.Collator('zh-Hans-CN-u-co-pinyin')
    } catch {
      return new Intl.Collator('zh')
    }
  }, [])

  useEffect(() => {
    if (open) {
      setList([...state.students])
      savedList.current = [...state.students]
      setText(state.students.join('\n'))
      setAdvanced(false)
      setNewName('')
      setEditIndex(-1)
      setMenuIndex(-1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /* 序号菜单打开时，点击任意处关闭 */
  useEffect(() => {
    if (menuIndex === -1) return
    const close = () => setMenuIndex(-1)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuIndex])

  const unsavedChanges =
    list.length !== savedList.current.length || list.some((name, i) => name !== savedList.current[i])

  const addStudent = () => {
    const name = newName.trim()
    if (!name || list.includes(name)) return
    setList([...list, name])
    setNewName('')
  }

  const saveEdit = () => {
    if (editIndex !== -1) {
      const trimmed = editName.trim()
      if (trimmed && trimmed !== list[editIndex]) {
        const next = [...list]
        next[editIndex] = trimmed
        setList(next)
      }
      setEditIndex(-1)
      setEditName('')
    }
  }

  const removeStudent = (index: number) => {
    setList(list.filter((_, i) => i !== index))
  }

  const moveStudent = (index: number, direction: 'top' | 'up' | 'down') => {
    if (direction === 'top') {
      if (index <= 0) return
      setList([list[index], ...list.slice(0, index), ...list.slice(index + 1)])
      return
    }
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= list.length) return
    const next = [...list]
    ;[next[index], next[target]] = [next[target], next[index]]
    setList(next)
  }

  const sortStudentsByPinyin = () => {
    setList([...list].sort((a, b) => pinyinCollator.compare(a, b)))
  }

  const toggleAdvanced = () => {
    // 与上游 watcher 一致：进入高级模式时用当前草稿生成文本
    if (!advanced) setText(list.join('\n'))
    setAdvanced(!advanced)
  }

  const reloadStudents = () => {
    setList([...state.students])
    savedList.current = [...state.students]
    setText(state.students.join('\n'))
    setEditIndex(-1)
  }

  const saveStudents = async () => {
    const names = advanced ? parseNames(text) : list.map((name) => name.trim()).filter(Boolean)
    if (names.length === 0) {
      toast.warning('名单为空', '至少保留一位学生')
      return
    }
    const saved = await store.setStudents(names)
    if (!saved) return
    setList(names)
    savedList.current = [...names]
    setText(names.join('\n'))
    toast.success('保存成功', '学生列表已更新')
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="d-flex align-center">
          <MdiIcon name="account-group" size={24} className="mr-2" />
          学生列表
          {unsavedChanges && (
            <span className="v-chip v-chip--size-small v-chip--variant-tonal ml-2" data-color="warning">
              <MdiIcon name="alert" size={16} />
              有未保存的更改
            </span>
          )}
        </span>
      }
      width={1080}
      fullscreenOnMobile
      className={unsavedChanges ? 'dialog-unsaved' : ''}
    >
      {/* 顶部操作：排序 / 高级编辑 */}
      <div className="d-flex justify-end flex-wrap mb-2" style={{ gap: 4 }}>
        <button
          type="button"
          className="v-btn v-btn--variant-text mr-2"
          disabled={list.length === 0}
          onClick={sortStudentsByPinyin}
        >
          <MdiIcon name="sort-alphabetical-variant" size={18} />
          按姓名首字母排序
        </button>
        <button
          type="button"
          className={`v-btn v-btn--variant-text ${advanced ? 'btn-tonal' : ''}`}
          onClick={toggleAdvanced}
        >
          <MdiIcon name="code-braces" size={18} />
          {advanced ? '返回基础编辑' : '高级编辑'}
        </button>
      </div>

      {advanced ? (
        <div style={{ paddingTop: 8 }}>
          <label className="v-label" htmlFor="student-bulk-text">
            批量编辑学生列表
          </label>
          <textarea
            id="student-bulk-text"
            className="v-field"
            rows={10}
            style={{ fontFamily: 'var(--font-mono)' }}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'每行输入一个学生姓名'}
          />
          <div className="text-caption" style={{ opacity: 0.7 }}>
            使用文本编辑模式批量编辑学生名单，保存时会自动去除空行
          </div>
        </div>
      ) : (
        <>
          {/* 添加学生 */}
          <div className="mb-6">
            <label className="v-label" htmlFor="student-add-input">
              添加学生
            </label>
            <div className="v-field">
              <MdiIcon
                name="account-plus"
                size={20}
                className="pointer-events-none mr-2"
                style={{ color: 'rgba(var(--v-theme-on-surface), 0.5)' }}
              />
              <input
                id="student-add-input"
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    addStudent()
                  }
                }}
                placeholder="输入学生姓名后回车添加"
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
              <button
                type="button"
                className="v-btn v-btn--icon v-btn--variant-text v-btn--size-small"
                style={{ color: 'rgb(var(--v-theme-primary))' }}
                disabled={!newName.trim()}
                onClick={addStudent}
                aria-label="添加学生"
              >
                <MdiIcon name="plus" size={20} />
              </button>
            </div>
          </div>

          {/* 学生卡片网格 */}
          <div className="student-manage-grid">
            {list.map((name, index) => (
              <div
                key={`${index}-${name}`}
                className={`v-card border student-card${isMobile ? ' is-mobile' : ''}`}
              >
                <div className="d-flex align-center" style={{ padding: 12 }}>
                  <span style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-tonal mr-3 font-weight-medium"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuIndex(menuIndex === index ? -1 : index)
                      }}
                    >
                      {index + 1}
                    </button>
                    {menuIndex === index && (
                      <div className="student-menu" onClick={(event) => event.stopPropagation()}>
                        <div className="v-list">
                          <button
                            type="button"
                            className="v-list-item"
                            disabled={index === 0}
                            onClick={() => {
                              moveStudent(index, 'top')
                              setMenuIndex(-1)
                            }}
                          >
                            <MdiIcon name="arrow-up-bold" size={18} className="mr-2" />
                            <span className="v-list-item-title">置顶</span>
                          </button>
                          <hr className="v-divider" />
                          <button
                            type="button"
                            className="v-list-item"
                            disabled={index === 0}
                            onClick={() => {
                              moveStudent(index, 'up')
                              setMenuIndex(-1)
                            }}
                          >
                            <MdiIcon name="arrow-up" size={18} className="mr-2" />
                            <span className="v-list-item-title">上移</span>
                          </button>
                          <button
                            type="button"
                            className="v-list-item"
                            disabled={index === list.length - 1}
                            onClick={() => {
                              moveStudent(index, 'down')
                              setMenuIndex(-1)
                            }}
                          >
                            <MdiIcon name="arrow-down" size={18} className="mr-2" />
                            <span className="v-list-item-title">下移</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </span>

                  {editIndex === index ? (
                    <input
                      className="student-name-input"
                      value={editName}
                      autoFocus
                      onChange={(event) => setEditName(event.target.value)}
                      onBlur={saveEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          saveEdit()
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="text-body-1 flex-grow-1"
                      style={{ cursor: isMobile ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      onClick={() => {
                        if (isMobile) {
                          setEditIndex(index)
                          setEditName(name)
                        }
                      }}
                    >
                      {name}
                    </span>
                  )}

                  <div className="d-flex action-buttons" style={{ gap: 4 }}>
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--variant-text v-btn--size-small"
                      data-color="primary"
                      onClick={() => {
                        setEditIndex(index)
                        setEditName(name)
                      }}
                      aria-label={`编辑 ${name}`}
                    >
                      <MdiIcon name="pencil" size={18} />
                    </button>
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--variant-text v-btn--size-small"
                      data-color="error"
                      onClick={() => removeStudent(index)}
                      aria-label={`删除 ${name}`}
                    >
                      <MdiIcon name="delete" size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 保存 / 重载 */}
      <div className="d-flex flex-wrap mt-6" style={{ gap: 8 }}>
        <button
          type="button"
          className="v-btn v-btn--size-large v-btn--variant-elevated"
          data-color="primary"
          onClick={() => void saveStudents()}
        >
          <MdiIcon name="content-save" size={18} />
          保存名单
        </button>
        <button
          type="button"
          className="v-btn v-btn--size-large v-btn--variant-outlined"
          data-color="error"
          onClick={reloadStudents}
        >
          <MdiIcon name="refresh" size={18} />
          重载名单
        </button>
      </div>
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

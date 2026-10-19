import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppBar } from '../components/AppBar'
import { AttendanceCard, AttendanceDialog, AttendanceSidebar } from '../components/Attendance'
import { EditDialog } from '../components/EditDialog'
import { FloatingToolbar } from '../components/FloatingToolbar'
import { HitokotoCard } from '../components/HitokotoCard'
import { EmptySubjectCard, HomeworkCard } from '../components/HomeworkCard'
import { Icon } from '../components/Icon'
import { RandomPicker } from '../components/RandomPicker'
import { StudentsDialog, SubjectsDialog } from '../components/PeopleDialogs'
import { TimeCard } from '../components/TimeCard'
import { UafTransferDialog } from '../components/UafTransferDialog'
import { isSameDay, relativeDayLabel, today } from '../lib/date'
import { useAppState, useMediaQuery, useMasonry, useSetting } from '../lib/hooks'
import { store } from '../lib/store'
import { toast } from '../lib/toast'
import type { ExamConfig } from '../lib/types'

type BoardItem =
  | { key: string; kind: 'subject'; name: string; content: string; order: number }
  | { key: string; kind: 'custom'; name: string; content: string; order: number }
  | { key: string; kind: 'exam'; examId: string; order: number }
  | { key: string; kind: 'time'; order: number }
  | { key: string; kind: 'hitokoto'; order: number }
  | { key: string; kind: 'attendance'; order: number }

interface HomeProps {
  onOpenSettings: () => void
  onNavigate: (path: 'list' | 'exams') => void
  isFullscreen: boolean
  onToggleFullscreen: () => void
  pendingEdit?: string | null
  onPendingEditHandled?: () => void
}

export function Home({
  onOpenSettings,
  onNavigate,
  isFullscreen,
  onToggleFullscreen,
  pendingEdit,
  onPendingEditHandled,
}: HomeProps) {
  const state = useAppState()
  const [emptyDisplay] = useSetting<string>('display.emptySubjectDisplay')
  const [forceDesktop] = useSetting<boolean>('display.forceDesktopMode')
  const [showListEntry] = useSetting<boolean>('display.showListCard')
  const [showExamEntry] = useSetting<boolean>('display.showExamScheduleButton')
  const [showUaf] = useSetting<boolean>('display.showUafTransfer')
  const [showFullscreen] = useSetting<boolean>('display.showFullscreenButton')
  const [randomEnabled] = useSetting<boolean>('randomPicker.enabled')
  const [blockPast] = useSetting<boolean>('edit.blockPastDataEdit')
  const [devMode] = useSetting<boolean>('developer.enabled')
  const [showTestCard] = useSetting<boolean>('developer.showTestCard')
  const [timeCardEnabled] = useSetting<boolean>('timeCard.enabled')
  const [hitokotoEnabled] = useSetting<boolean>('hitokoto.enabled')
  const [className] = useSetting<string>('server.classNumber')
  const [antiBurn] = useSetting<boolean>('display.showAntiScreenBurnCard')

  const isMobile = useMediaQuery('(max-width: 799px)')
  const wideScreen = useMediaQuery('(min-width: 960px)')
  const isDesktop = forceDesktop || wideScreen
  /** 800–959px 既没有侧栏也不该丢掉出勤入口，统一用卡片承载（F4） */
  const showAttendanceCard = !isDesktop

  const [editing, setEditing] = useState<
    { kind: 'subject' | 'custom'; key: string; name: string; content: string } | null
  >(null)
  const [attendanceOpen, setAttendanceOpen] = useState(false)
  const [studentsOpen, setStudentsOpen] = useState(false)
  const [subjectsOpen, setSubjectsOpen] = useState(false)
  const [randomOpen, setRandomOpen] = useState(false)
  const [uafOpen, setUafOpen] = useState(false)
  const [uafMode, setUafMode] = useState<'export' | 'import'>('export')
  const [uafMenu, setUafMenu] = useState(false)
  const [highlight, setHighlight] = useState<Record<string, boolean>>({})
  const [examDialog, setExamDialog] = useState<string | null>(null)

  const isToday = isSameDay(state.date, today())
  const editBlocked = !isToday && blockPast

  useEffect(() => {
    document.title = `${className} - ${isToday ? '今天的作业' : `${relativeDayLabel(state.date)}的作业`} · ClassworksLite`
  }, [className, state.date, isToday])

  /* ---------------- 卡片排序（对齐上游 sortedItems） ---------------- */
  const items = useMemo<BoardItem[]>(() => {
    const list: BoardItem[] = []

    if (showAttendanceCard) list.push({ key: 'attendance-card', kind: 'attendance', order: 0 })

    for (const [key, item] of Object.entries(state.board.homework)) {
      if (key.startsWith('exam-') && item.examId) {
        list.push({ key, kind: 'exam', examId: item.examId, order: -100 })
      }
    }

    for (const subject of state.subjects) {
      const content = state.board.homework[subject.name]?.content ?? ''
      if (content.trim()) {
        list.push({
          key: subject.name,
          kind: 'subject',
          name: subject.name,
          content,
          order: subject.order,
        })
      }
    }

    if (timeCardEnabled) list.push({ key: 'time-card', kind: 'time', order: 9997 })
    if (hitokotoEnabled) list.push({ key: 'hitokoto-card', kind: 'hitokoto', order: 9998 })

    for (const [key, item] of Object.entries(state.board.homework)) {
      if (key.startsWith('custom-')) {
        list.push({
          key,
          kind: 'custom',
          name: item.name ?? '自定义卡片',
          content: item.content ?? '',
          order: 9999,
        })
      }
    }

    return list.sort((a, b) => a.order - b.order)
  }, [state.board.homework, state.subjects, showAttendanceCard, timeCardEnabled, hitokotoEnabled])

  const { containerRef } = useMasonry([items.length, isMobile])

  const unusedSubjects = useMemo(() => {
    const used = new Set(
      Object.entries(state.board.homework)
        .filter(([, item]) => item.content?.trim())
        .map(([key]) => key),
    )
    return [...state.subjects].sort((a, b) => a.order - b.order).filter((s) => !used.has(s.name))
  }, [state.subjects, state.board.homework])

  const examMap = useMemo(() => {
    const map = new Map<string, ExamConfig>()
    state.exams.forEach((exam) => map.set(exam.id, exam))
    return map
  }, [state.exams])

  /* ---------------- 编辑 ---------------- */
  const openSubject = useCallback(
    (name: string) => {
      if (editBlocked) {
        toast.warning('无法编辑', '设置中已禁止编辑历史数据')
        return
      }
      setEditing({
        kind: 'subject',
        key: name,
        name,
        content: state.board.homework[name]?.content ?? '',
      })
    },
    [editBlocked, state.board.homework],
  )

  const openCustom = useCallback(
    (key: string) => {
      if (editBlocked) {
        toast.warning('无法编辑', '设置中已禁止编辑历史数据')
        return
      }
      const item = state.board.homework[key]
      setEditing({
        kind: 'custom',
        key,
        name: item?.name ?? '自定义卡片',
        content: item?.content ?? '',
      })
    },
    [editBlocked, state.board.homework],
  )

  useEffect(() => {
    if (!pendingEdit) return
    const timer = window.setTimeout(() => {
      openSubject(pendingEdit)
      onPendingEditHandled?.()
    }, 80)
    return () => window.clearTimeout(timer)
  }, [pendingEdit, openSubject, onPendingEditHandled])

  /* 支持 ?edit=科目 深链直接编辑 */
  const deepLinkDone = useRef(false)
  useEffect(() => {
    if (deepLinkDone.current || state.status !== 'ready') return
    const target = new URLSearchParams(window.location.search).get('edit')
    if (!target) {
      deepLinkDone.current = true
      return
    }
    const timer = window.setTimeout(() => {
      deepLinkDone.current = true
      openSubject(target)
    }, 260)
    return () => window.clearTimeout(timer)
  }, [state.status, openSubject])

  /* ---------------- 内容变化高亮 ---------------- */
  const previousHomework = useRef('')
  useEffect(() => {
    const snapshot = JSON.stringify(state.board.homework)
    const previousRaw = previousHomework.current
    previousHomework.current = snapshot
    if (!previousRaw || previousRaw === snapshot || state.dirty) return

    const previous = JSON.parse(previousRaw) as Record<string, { content?: string }>
    const changed: Record<string, boolean> = {}
    for (const [key, item] of Object.entries(state.board.homework)) {
      if ((previous[key]?.content ?? '') !== (item.content ?? '')) changed[key] = true
    }
    for (const key of Object.keys(previous)) {
      if (!(key in state.board.homework)) changed[key] = true
    }
    if (Object.keys(changed).length === 0) return

    setHighlight(changed)
    const timer = window.setTimeout(() => setHighlight({}), 6000)
    return () => window.clearTimeout(timer)
  }, [state.board.homework, state.dirty])

  const openUaf = (mode: 'export' | 'import') => {
    setUafMode(mode)
    setUafOpen(true)
    setUafMenu(false)
  }

  return (
    <>
      <AppBar
        onOpenSettings={onOpenSettings}
        actions={
          <button
            type="button"
            className="v-btn v-btn--icon v-btn--variant-text"
            onClick={() => void store.refresh()}
            title="刷新"
            aria-label="刷新"
          >
            <Icon name="refresh" size={22} />
          </button>
        }
      />

      <div className="d-flex" style={{ paddingTop: 'var(--appbar-h)' }}>
        <main className="flex-grow-1" style={{ minWidth: 0 }}>
          <div className="main-window" style={{ padding: '16px 16px 96px' }}>
            {state.status === 'error' && (
              <div className="v-alert v-alert--variant-tonal mb-4" data-color="error">
                <Icon name="warning" size={20} />
                <div>
                  <div className="font-weight-bold">数据加载失败</div>
                  <div>{state.error}</div>
                </div>
              </div>
            )}

            {state.offline && (
              <div className="v-alert v-alert--variant-tonal mb-4" data-color="warning">
                <Icon name="cloudOff" size={18} />
                当前展示的是本地缓存，网络恢复后会自动拉取最新数据。
              </div>
            )}

            {state.status === 'loading' && items.length === 0 ? (
              <HomeSkeleton />
            ) : (
              <>
                <div className="grid-masonry" ref={containerRef}>
                  {items.map((item) => {
                    const content = (() => {
                      if (item.kind === 'time') return <TimeCard />
                      if (item.kind === 'hitokoto') return <HitokotoCard />
                      if (item.kind === 'attendance') {
                        return <AttendanceCard onOpen={() => setAttendanceOpen(true)} />
                      }
                      if (item.kind === 'exam') {
                        return (
                          <ConciseExamCard
                            exam={examMap.get(item.examId)}
                            onOpen={() => setExamDialog(item.examId)}
                          />
                        )
                      }
                      return (
                        <HomeworkCard
                          name={item.name}
                          content={item.content}
                          custom={item.kind === 'custom'}
                          highlighted={highlight[item.key]}
                          disabled={editBlocked}
                          onOpen={() =>
                            item.kind === 'custom' ? openCustom(item.key) : openSubject(item.name)
                          }
                        />
                      )
                    })()

                    return (
                      <div className="grid-item" key={item.key} data-masonry-item>
                        {content}
                      </div>
                    )
                  })}
                </div>

                <div className="empty-subjects mt-4">
                  {isMobile ? (
                    <div className="d-flex flex-wrap justify-center">
                      {unusedSubjects.map((subject) => (
                        <EmptySubjectCard
                          key={subject.name}
                          name={subject.name}
                          variant="chip"
                          disabled={editBlocked}
                          onOpen={() => openSubject(subject.name)}
                        />
                      ))}
                    </div>
                  ) : emptyDisplay === 'button' ? (
                    <div className="v-btn-group v-btn-group--divided">
                      {unusedSubjects.map((subject) => (
                        <EmptySubjectCard
                          key={subject.name}
                          name={subject.name}
                          variant="button"
                          disabled={editBlocked}
                          onOpen={() => openSubject(subject.name)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="empty-subjects-grid">
                      {unusedSubjects.map((subject) => (
                        <EmptySubjectCard
                          key={subject.name}
                          name={subject.name}
                          variant="card"
                          disabled={editBlocked}
                          onOpen={() => openSubject(subject.name)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                <div className="d-flex flex-wrap align-center mt-4" style={{ gap: 8, rowGap: 12 }}>
                  {!state.dirty && !state.saving ? (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large rounded-xl"
                      data-color="success"
                      onClick={() => toast.success('同步完成', '作业数据已是最新')}
                    >
                      同步完成
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large rounded-xl"
                      data-color="error"
                      disabled={state.saving}
                      onClick={() => {
                        void store.save()
                      }}
                    >
                      上传
                    </button>
                  )}

                  {showUaf && (
                    <div style={{ position: 'relative' }}>
                      <button
                        type="button"
                        className="v-btn v-btn--size-large rounded-xl"
                        data-color="indigo"
                        title="UAF 导入导出"
                        onClick={() => setUafMenu((open) => !open)}
                      >
                        <Icon name="swapVertical" size={20} />
                      </button>
                      {uafMenu && (
                        <>
                          <div className="menu-backdrop" onClick={() => setUafMenu(false)} />
                          <div className="v-menu">
                            <button type="button" className="v-list-item" onClick={() => openUaf('export')}>
                              <Icon name="fileExport" size={18} className="mr-2" />
                              <span className="v-list-item-title">导出 UAF</span>
                            </button>
                            <button type="button" className="v-list-item" onClick={() => openUaf('import')}>
                              <Icon name="fileImport" size={18} className="mr-2" />
                              <span className="v-list-item-title">导入 UAF</span>
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {showFullscreen && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large rounded-xl"
                      data-color={isFullscreen ? 'blue-grey' : 'blue'}
                      onClick={onToggleFullscreen}
                    >
                      <Icon name={isFullscreen ? 'collapse' : 'expand'} size={20} />
                      {isFullscreen ? '退出全屏' : '全屏'}
                    </button>
                  )}

                  {randomEnabled && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large"
                      data-color="amber"
                      onClick={() => setRandomOpen(true)}
                    >
                      <Icon name="account" size={20} />
                      随机点名
                      <Icon name="grid" size={20} />
                    </button>
                  )}

                  {showExamEntry && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large"
                      data-color="green"
                      onClick={() => onNavigate('exams')}
                    >
                      <Icon name="calendarCheck" size={20} />
                      考试看板
                    </button>
                  )}

                  {showListEntry && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large"
                      data-color="primary"
                      onClick={() => onNavigate('list')}
                    >
                      <Icon name="listBox" size={20} />
                      列表
                    </button>
                  )}

                  {devMode && showTestCard && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-large"
                      data-color="purple"
                      onClick={() => {
                        if (editBlocked) {
                          toast.warning('无法编辑', '设置中已禁止编辑历史数据')
                          return
                        }
                        const key = store.addCustomCard('测试卡片', '')
                        setEditing({ kind: 'custom', key, name: '测试卡片', content: '' })
                      }}
                    >
                      <Icon name="testTube" size={20} />
                      添加测试卡片
                    </button>
                  )}
                </div>

                {antiBurn && (
                  <div className="v-card border anti-burn-card mt-4" data-color="primary">
                    <div className="v-card-title text-subtitle-1">
                      <Icon name="lock" size={18} className="mr-2" />
                      屏幕保护技术已启用
                    </div>
                    <div className="v-card-text text-body-2">
                      <p>为防止OLED/LCD屏幕烧屏，界面元素会定期微调位置。</p>
                      <p className="text-caption text-grey">此功能不会影响正常使用，仅在长时间静止显示时生效。</p>
                      <p className="text-caption text-grey">建议在放学后关闭显示器以节约能源。</p>
                    </div>
                  </div>
                )}

                <UafTransferDialog
                  open={uafOpen}
                  mode={uafMode}
                  currentDate={state.dateKey}
                  subjects={state.subjects}
                  onClose={() => setUafOpen(false)}
                  onImported={() => {
                    void store.refresh()
                  }}
                />
              </>
            )}
          </div>
        </main>

        {isDesktop && <AttendanceSidebar onOpen={() => setAttendanceOpen(true)} />}
      </div>

      <FloatingToolbar />

      <EditDialog
        open={Boolean(editing)}
        title={editing?.name ?? ''}
        initialContent={editing?.content ?? ''}
        date={state.date}
        isPast={!isToday}
        custom={editing?.kind === 'custom'}
        onRename={(name) => editing && store.renameCustomCard(editing.key, name)}
        onDelete={() => editing && store.removeHomework(editing.key)}
        onSave={(content) => {
          if (!editing) return
          store.setHomework(editing.key, content)
        }}
        onClose={() => setEditing(null)}
      />

      <AttendanceDialog
        open={attendanceOpen}
        onClose={() => setAttendanceOpen(false)}
        canEdit={!editBlocked}
        onBlocked={() => toast.warning('无法编辑', '设置中已禁止编辑历史数据')}
      />

      <StudentsDialog open={studentsOpen} onClose={() => setStudentsOpen(false)} />
      <SubjectsDialog open={subjectsOpen} onClose={() => setSubjectsOpen(false)} />
      <RandomPicker open={randomOpen} onClose={() => setRandomOpen(false)} />

      {/* 考试详情 */}
      {examDialog && (
        <ExamDetailDialog
          examId={examDialog}
          onClose={() => setExamDialog(null)}
          onOpenBoard={() => {
            setExamDialog(null)
            onNavigate('exams')
          }}
          onRemove={() => {
            if (editBlocked) {
              toast.warning('无法编辑', '设置中已禁止编辑历史数据')
              setExamDialog(null)
              return
            }
            const exam = examMap.get(examDialog)
            if (exam) store.addExamCard(exam.id)
            setExamDialog(null)
          }}
        />
      )}
    </>
  )
}

function HomeSkeleton() {
  return (
    <div className="grid-masonry">
      {[220, 180, 260, 200, 170, 240].map((height, index) => (
        <div className="grid-item" key={index}>
          <div className="v-card border rounded-xl" style={{ padding: 16, minHeight: height }}>
            <div className="skeleton" style={{ height: 20, width: 80 }} />
            <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
              <div className="skeleton" style={{ height: 14, width: '100%' }} />
              <div className="skeleton" style={{ height: 14, width: '80%' }} />
              <div className="skeleton" style={{ height: 14, width: '60%' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 考试卡片（对齐 ConciseExamCard.vue） */
function ConciseExamCard({ exam, onOpen }: { exam?: ExamConfig; onOpen: () => void }) {
  if (!exam) {
    return (
      <article className="v-card border rounded-xl" style={{ padding: 16 }}>
        <div className="text-caption text-grey">考试配置已删除</div>
      </article>
    )
  }

  const groups = new Map<string, ExamConfig['subjects']>()
  for (const subject of [...exam.subjects].sort((a, b) =>
    (a.date + (a.start ?? '')).localeCompare(b.date + (b.start ?? '')),
  )) {
    const list = groups.get(subject.date) ?? []
    list.push(subject)
    groups.set(subject.date, list)
  }

  return (
    <article className="v-card border rounded-xl hover-card" onClick={onOpen}>
      <div className="v-card-title text-subtitle-1 font-weight-bold" style={{ background: 'rgba(var(--v-theme-primary), 0.05)' }}>
        <span className="text-truncate">{exam.examName}</span>
      </div>
      <div className="v-card-text" style={{ padding: 16 }}>
        {exam.subjects.length === 0 ? (
          <div className="text-center text-caption text-grey">暂无考试安排</div>
        ) : (
          [...groups.entries()].map(([date, subjects]) => (
            <div key={date} className="mb-3">
              <div className="text-subtitle-2 font-weight-bold text-primary mb-1">
                {formatRelativeDate(date)}
              </div>
              {subjects.map((subject, index) => (
                <div
                  key={`${subject.name}-${index}`}
                  className="d-flex align-center justify-space-between py-1"
                  style={{
                    borderBottom:
                      index === subjects.length - 1
                        ? 'none'
                        : '1px solid rgba(var(--v-border-color), var(--v-border-opacity))',
                  }}
                >
                  <div className="font-weight-bold mr-2" style={{ fontSize: '1.1em' }}>
                    {subject.name}
                  </div>
                  <div className="font-weight-medium text-grey-darken-2" style={{ fontSize: '0.85em' }}>
                    {subject.start ?? '--:--'} - {subject.end ?? '--:--'}
                  </div>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </article>
  )
}

function formatRelativeDate(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(date.getTime())) return dateStr
  const todayDate = new Date()
  const diff = Math.round(
    (new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
      new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate()).getTime()) /
      86400000,
  )
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  if (diff === -1) return '昨天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function ExamDetailDialog({
  examId,
  onClose,
  onOpenBoard,
  onRemove,
}: {
  examId: string
  onClose: () => void
  onOpenBoard: () => void
  onRemove: () => void
}) {
  const state = useAppState()
  const exam = state.exams.find((item) => item.id === examId)

  return (
    <div className="v-overlay" role="dialog" aria-modal="true">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="v-dialog" style={{ maxWidth: 500, position: 'relative' }}>
        <div className="v-card-title">考试看板</div>
        <div className="v-card-text">
          <div className="v-list">
            <button type="button" className="v-list-item v-list-item--active" onClick={onOpenBoard}>
              <span className="v-list-item-title">打开考试看板</span>
              <div className="flex-grow-1" />
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
          <div className="v-list">
            {exam ? (
              <div className="v-list-item">
                <Icon name="calendar" size={20} className="text-primary mr-3" />
                <div>
                  <div className="v-list-item-title">{exam.examName}</div>
                  <div className="v-list-item-subtitle">{exam.id}</div>
                </div>
              </div>
            ) : (
              <div className="text-center py-4 text-grey">暂无考试配置</div>
            )}
          </div>
        </div>
        <div className="v-card-actions">
          <button type="button" className="v-btn v-btn--variant-tonal" data-color="error" onClick={onRemove}>
            <Icon name="trash" size={18} />
            移除卡片
          </button>
          <div className="flex-grow-1" />
          <button type="button" className="v-btn v-btn--variant-text" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

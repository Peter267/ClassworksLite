import { AppBar } from '../components/AppBar'
import { Icon } from '../components/Icon'
import { longDate, weekdayLabel } from '../lib/date'
import { useAppState } from '../lib/hooks'
import { attendanceStats, countLines, store } from '../lib/store'
import { settings } from '../lib/settings'

/** 列表页：对齐上游 /list 的 v-app-bar + v-card + v-list 结构 */
export function ListPage({
  onBack,
  onEdit,
}: {
  onBack: () => void
  onEdit: (subject: string) => void
}) {
  const state = useAppState()
  const subjects = [...state.subjects].sort((a, b) => a.order - b.order)
  // 与首页共用同一套统计规则（是否把迟到计入实到）
  const { present, absent, late, exclude } = attendanceStats(state.board, state.students)
  const filled = subjects.filter((subject) => state.board.homework[subject.name]?.content?.trim())

  return (
    <>
      <AppBar title="列表" back={{ label: '返回', onBack }} hideSettings />
      <div className="page-container" style={{ paddingTop: 'calc(var(--appbar-h) + 16px)', paddingBottom: 96 }}>
        <div className="d-flex align-center mb-4 flex-wrap" style={{ gap: 12 }}>
          <h1 className="text-h5">
            {settings.get<string>('server.classNumber')} 作业清单
          </h1>
          <span className="text-body-2 text-medium-emphasis">
            {longDate(state.date)} {weekdayLabel(state.date)} · 共 {filled.length} 科 /{' '}
            {countLines(filled.map((s) => state.board.homework[s.name].content).join('\n'))} 条
          </span>
          <div className="flex-grow-1" />
          <button
            type="button"
            className="v-btn v-btn--size-small v-btn--variant-outlined"
            onClick={() => window.print()}
          >
            <Icon name="download" size={16} />
            打印
          </button>
        </div>

        <section className="v-card border rounded-xl mb-5">
          <div className="v-card-title">作业清单</div>
          <div className="v-card-text" style={{ paddingTop: 0 }}>
            <div
              className="d-flex align-center justify-space-between text-caption"
              style={{ padding: '8px 0', opacity: 0.75 }}
            >
              <span>
                实到 <b>{present}</b> / {state.students.length}
              </span>
              <span className="d-flex" style={{ gap: 16 }}>
                {absent > 0 && <span className="text-error">请假 {absent}</span>}
                {late > 0 && <span className="text-warning">迟到 {late}</span>}
                {exclude > 0 && <span>不参与 {exclude}</span>}
                {absent + late + exclude === 0 && (
                  <span className="text-success">全勤</span>
                )}
              </span>
            </div>
          </div>

          <hr className="v-divider" />

          <div className="v-list" style={{ padding: '8px 0' }}>
            {subjects.map((subject) => {
              const content = state.board.homework[subject.name]?.content ?? ''
              const lines = content.split('\n').filter((line) => line.trim())
              return (
                <div
                  key={subject.name}
                  className="v-list-item"
                  style={{ alignItems: 'flex-start', padding: '12px 16px' }}
                >
                  <div
                    className="text-subtitle-2 font-weight-medium"
                    style={{ width: 64, flexShrink: 0, opacity: lines.length ? 1 : 0.5 }}
                  >
                    {subject.name}
                  </div>
                  <div className="flex-grow-1" style={{ minWidth: 0 }}>
                    {lines.length > 0 ? (
                      <div className="text-body-2" style={{ lineHeight: 1.7 }}>
                        {lines.map((line, index) => (
                          <div key={index} className="d-flex" style={{ gap: 8 }}>
                            <span className="text-medium-emphasis">·</span>
                            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{line.trim()}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-caption text-medium-emphasis">无作业</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                    onClick={() => onEdit(subject.name)}
                    aria-label={`编辑${subject.name}`}
                  >
                    <Icon name="edit" size={18} />
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        <div className="d-flex justify-center">
          <button type="button" className="v-btn v-btn--variant-tonal" data-color="primary" onClick={() => void store.save()}>
            <Icon name="upload" size={16} />
            保存当前修改
          </button>
        </div>
      </div>
    </>
  )
}

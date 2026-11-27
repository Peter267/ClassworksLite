import { useCallback, useMemo, useRef, useState } from 'react'
import { MdiIcon } from '../MdiIcon'
import { ConfirmDialog, Modal } from '../ui/Modal'
import { AdminError, adminApi } from '../../lib/admin'
import { relativeTime } from '../../lib/date'
import { toast } from '../../lib/toast'
import {
  buildBackupPlan,
  MAX_BACKUP_BYTES,
  parseBackup,
  summarizeBackup,
  type BackupAction,
  type BackupPlan,
  type BackupPlanRow,
  type BackupStrategy,
  type ParsedBackup,
} from '../../lib/localBackupImport'
import {
  chunkImportRecords,
  IMPORT_CATEGORY_LABELS,
  type ImportCategory,
  type LocalRecord,
} from '../../lib/upstreamImport'

interface RestoreResult {
  imported: number
  skipped: number
  failed: { key: string; message: string }[]
  bytes: number
  chunks: number
  durationMs: number
  cancelled?: boolean
}

const PLAN_PAGE_SIZE = 40
const LOCAL_CHUNK = 200
const CATEGORY_ICON: Record<ImportCategory, string> = {
  board: 'calendar-check',
  students: 'school',
  subjects: 'notebook',
  exams: 'calendar',
  template: 'text-box-outline',
  noise: 'microphone',
  other: 'database',
}
const ACTION_LABEL: Record<BackupAction, string> = {
  new: '新增',
  overwrite: '覆盖',
  skip: '跳过',
  error: '错误',
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTime(ts: number) {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : '未知错误'
}

function prettyJson(value: unknown) {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? 'null'
  } catch {
    return '（无法序列化）'
  }
  const limit = 200_000
  return text.length > limit ? `${text.slice(0, limit)}\n…（内容过长，已截断预览）` : text
}

function actionClass(action: BackupAction) {
  return `import-action import-action--${action}`
}

function StrategyCard({
  active,
  title,
  description,
  onClick,
}: {
  active: boolean
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`import-strategy ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="import-strategy-dot" />
      <span>
        <span className="import-strategy-title">{title}</span>
        <span className="import-strategy-desc">{description}</span>
      </span>
    </button>
  )
}

export function LocalBackupImportPanel({
  adminToken,
  onChanged,
  onOpenData,
  onAuthError,
}: {
  adminToken: string
  onChanged: () => void
  onOpenData: () => void
  onAuthError?: (err: unknown) => void
}) {
  const [dragActive, setDragActive] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedBackup | null>(null)
  const [strategy, setStrategy] = useState<BackupStrategy>('overwrite')

  const [plan, setPlan] = useState<BackupPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planProgress, setPlanProgress] = useState<{ done: number; total: number } | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planFilter, setPlanFilter] = useState<'all' | 'change' | 'skip' | 'error'>('all')
  const [planPage, setPlanPage] = useState(0)
  const [previewRow, setPreviewRow] = useState<BackupPlanRow | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<{
    chunk: number
    totalChunks: number
    imported: number
    skipped: number
    failed: number
    bytes: number
  } | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [auditWarning, setAuditWarning] = useState<string | null>(null)
  const cancelRef = useRef(false)

  const handleAdminError = useCallback(
    (err: unknown) => {
      if (err instanceof AdminError && err.status === 401) {
        onAuthError?.(err)
        return true
      }
      return false
    },
    [onAuthError],
  )

  const invalidatePlan = useCallback(() => {
    setPlan(null)
    setPlanError(null)
    setResult(null)
  }, [])

  const readFile = useCallback(async (file: File) => {
    setParseError(null)
    setParsed(null)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    if (!/\.json$/i.test(file.name)) {
      setParseError('请选择由「导出全站备份」生成的 JSON 文件')
      return
    }
    if (file.size > MAX_BACKUP_BYTES) {
      setParseError(
        `备份文件 ${formatBytes(file.size)}，超过 ${Math.floor(
          MAX_BACKUP_BYTES / 1024 / 1024,
        )} MB 上限，请拆分后再导入`,
      )
      return
    }
    setParsing(true)
    try {
      const text = await file.text()
      setParsed(parseBackup(text, file.name, file.size))
    } catch (err) {
      setParseError(errorMessage(err))
    } finally {
      setParsing(false)
    }
  }, [])

  async function loadLocalRecords(keys: string[]): Promise<Map<string, LocalRecord>> {
    const records = new Map<string, LocalRecord>()
    let done = 0
    setPlanProgress({ done: 0, total: keys.length })

    const readChunk = async (chunk: string[]): Promise<void> => {
      try {
        const response = await adminApi.getMany(adminToken, chunk)
        for (const item of response.records) {
          if (item.found) {
            records.set(item.key, { value: item.value, updatedAt: item.updatedAt ?? 0 })
          }
        }
      } catch (err) {
        if (handleAdminError(err)) throw err
        // 单条数据很大时 get_many 会因响应体积被拒，二分重试
        if (err instanceof AdminError && err.status === 413 && chunk.length > 1) {
          const middle = Math.ceil(chunk.length / 2)
          await readChunk(chunk.slice(0, middle))
          await readChunk(chunk.slice(middle))
          return
        }
        throw err
      }
      done += chunk.length
      setPlanProgress({ done, total: keys.length })
    }

    for (let index = 0; index < keys.length; index += LOCAL_CHUNK) {
      await readChunk(keys.slice(index, index + LOCAL_CHUNK))
    }
    return records
  }

  async function generatePlan() {
    if (!parsed || planLoading) return
    setPlanLoading(true)
    setPlan(null)
    setPlanError(null)
    setResult(null)
    setPlanProgress({ done: 0, total: parsed.records.length })
    try {
      const local = await loadLocalRecords(parsed.records.map((record) => record.key))
      setPlan(buildBackupPlan(parsed, local, strategy))
      setPlanFilter('all')
      setPlanPage(0)
    } catch (err) {
      if (!handleAdminError(err)) setPlanError(errorMessage(err))
    } finally {
      setPlanLoading(false)
      setPlanProgress(null)
    }
  }

  async function executeImport() {
    if (!plan || importing || plan.records.length === 0) return
    setConfirmOpen(false)
    setImporting(true)
    setResult(null)
    setAuditWarning(null)
    cancelRef.current = false
    const chunks = chunkImportRecords(plan.records, 50, 700_000)
    const started = Date.now()
    let imported = 0
    let skipped = plan.counts.skip
    let bytes = 0
    let authAborted = false
    const failed: { key: string; message: string }[] = plan.rows
      .filter((row) => row.action === 'error')
      .map((row) => ({ key: row.key, message: row.reason ?? '数据异常，未导入' }))

    setProgress({
      chunk: 0,
      totalChunks: chunks.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
    })

    for (let index = 0; index < chunks.length; index += 1) {
      if (cancelRef.current) break
      const chunk = chunks[index]
      try {
        const response = await adminApi.importRecords(adminToken, chunk, {
          skipExisting: strategy === 'skip',
          silent: true,
          guardLocal: true,
          auditStart: chunks.length > 1 && index === 0,
          totalRecords: plan.records.length,
          source: 'backup',
        })
        imported += response.imported.length
        skipped += response.skipped.length
        bytes += response.bytes
        failed.push(...response.failed)
      } catch (err) {
        if (handleAdminError(err)) {
          authAborted = true
          break
        }
        for (const record of chunk) {
          failed.push({ key: record.key, message: errorMessage(err) })
        }
      }
      setProgress({
        chunk: index + 1,
        totalChunks: chunks.length,
        imported,
        skipped,
        failed: failed.length,
        bytes,
      })
    }

    const cancelled = cancelRef.current || authAborted
    if (!authAborted && (imported > 0 || skipped > 0 || failed.length > 0)) {
      try {
        await adminApi.importSummary(adminToken, {
          imported,
          skipped,
          failed: failed.length,
          bytes,
          cancelled,
          source: 'backup',
        })
      } catch (err) {
        if (!handleAdminError(err)) {
          setAuditWarning('数据已处理，但汇总操作日志写入失败，请手动记录本次导入结果')
        }
      }
    }

    setImporting(false)
    setProgress(null)
    setResult({
      imported,
      skipped,
      failed,
      bytes,
      chunks: chunks.length,
      durationMs: Date.now() - started,
      cancelled,
    })
    if (imported > 0) {
      toast.success(
        cancelled ? '导入已取消' : '导入完成',
        `已写入 ${imported} 条数据${skipped ? `，跳过 ${skipped} 条` : ''}${
          failed.length ? `，失败 ${failed.length} 条` : ''
        }`,
      )
      onChanged()
    } else if (!cancelled) {
      toast.error('导入失败', failed[0]?.message ?? '没有数据成功写入')
    }
  }

  const scope = useMemo(() => (parsed ? summarizeBackup(parsed) : null), [parsed])

  const filteredRows = useMemo(() => {
    if (!plan) return []
    if (planFilter === 'all') return plan.rows
    if (planFilter === 'change') {
      return plan.rows.filter((row) => row.action === 'new' || row.action === 'overwrite')
    }
    return plan.rows.filter((row) =>
      planFilter === 'skip' ? row.action === 'skip' : row.action === 'error',
    )
  }, [plan, planFilter])

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PLAN_PAGE_SIZE))
  const safePage = Math.min(planPage, pageCount - 1)
  const pagedRows = filteredRows.slice(
    safePage * PLAN_PAGE_SIZE,
    safePage * PLAN_PAGE_SIZE + PLAN_PAGE_SIZE,
  )

  const actionable = plan?.records.length ?? 0
  const overwriteCount = plan?.counts.overwrite ?? 0

  return (
    <div className="import-panel">
      <div className="import-steps" aria-label="导入步骤">
        {[
          { index: 1, label: '选择备份文件' },
          { index: 2, label: '比对本地数据' },
          { index: 3, label: '预览并导入' },
        ].map((item) => {
          const step = !parsed ? 1 : plan ? 3 : 2
          return (
            <div
              key={item.index}
              className={`import-step ${step === item.index ? 'active' : ''} ${
                step > item.index ? 'done' : ''
              }`}
            >
              <span className="import-step-index">
                {step > item.index ? <MdiIcon name="check" size={16} /> : item.index}
              </span>
              {item.label}
            </div>
          )
        })}
      </div>

      <section className="v-card admin-card import-card">
        <div className="admin-card-head">
          <h2 className="text-subtitle-1 font-weight-medium">选择本地备份</h2>
          <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="primary">
            <MdiIcon name="shield-check" size={14} />
            仅本机读取
          </span>
        </div>
        <div className="admin-card-body">
          <label
            className={`import-file-drop ${dragActive ? 'active' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              setDragActive(true)
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragActive(false)
              const file = event.dataTransfer.files?.[0]
              if (file) void readFile(file)
            }}
          >
            <MdiIcon name="file-import-outline" size={28} />
            <span className="text-body-2">
              {parsing ? '正在解析备份文件…' : '拖入备份 JSON，或点击选择文件'}
            </span>
            <span className="text-caption text-medium-emphasis">
              支持「导出全站备份」生成的 classworks-lite-backup-*.json，文件不会上传到任何第三方
            </span>
            <input
              type="file"
              accept="application/json,.json"
              disabled={parsing || importing}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void readFile(file)
                event.target.value = ''
              }}
              hidden
            />
          </label>

          {parseError && (
            <div className="v-alert v-alert--variant-tonal import-alert" data-color="error">
              <MdiIcon name="alert-circle-outline" size={20} />
              <div>{parseError}</div>
            </div>
          )}

          {parsed && (
            <>
              <div className="import-connection-meta mt-4">
                <span>
                  <b>文件</b>
                  {parsed.fileName}
                </span>
                <span>
                  <b>大小</b>
                  {formatBytes(parsed.bytes)}
                </span>
                <span>
                  <b>导出时间</b>
                  {parsed.exportedAt ? formatTime(parsed.exportedAt) : '未记录'}
                </span>
                <span>
                  <b>数据键</b>
                  {parsed.records.length}
                  {parsed.declaredCount !== null && parsed.declaredCount !== parsed.records.length
                    ? `（声明 ${parsed.declaredCount}）`
                    : ''}
                </span>
                <span>
                  <b>内容</b>
                  作业 {scope?.boards ?? 0} · 配置 {scope?.config ?? 0}
                  {scope?.other ? ` · 其他 ${scope.other}` : ''}
                </span>
              </div>
              {parsed.warnings.map((warning) => (
                <div className="import-inline-warning" key={warning}>
                  <MdiIcon name="alert-circle-outline" size={16} />
                  {warning}
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="v-card admin-card import-card">
        <div className="admin-card-head">
          <h2 className="text-subtitle-1 font-weight-medium">冲突处理与预览</h2>
          <span className="text-caption text-medium-emphasis">
            覆盖前会与本地逐键比对
          </span>
        </div>
        <div className="admin-card-body">
          <div className="import-strategy-grid import-strategy-grid--two">
            <StrategyCard
              active={strategy === 'overwrite'}
              title="覆盖同名键（推荐）"
              description="按备份内容恢复本地数据；内容一致的键自动跳过。"
              onClick={() => {
                setStrategy('overwrite')
                invalidatePlan()
              }}
            />
            <StrategyCard
              active={strategy === 'skip'}
              title="仅导入新键"
              description="本地已有的键全部保留，只补齐备份中新增的数据键。"
              onClick={() => {
                setStrategy('skip')
                invalidatePlan()
              }}
            />
          </div>

          <div className="import-note">
            <MdiIcon name="information-outline" size={18} />
            <div>
              预览会逐键读取本地数据并给出处理方式；写入时带版本校验，若某条数据在预览后被修改，
              该条会写入失败并列入结果，可在处理后重新预览重试。
            </div>
          </div>

          {planError && (
            <div className="v-alert v-alert--variant-tonal import-alert" data-color="error">
              <MdiIcon name="alert-circle-outline" size={20} />
              <div>{planError}</div>
            </div>
          )}

          {planLoading ? (
            <div className="import-progress-card">
              <div className="d-flex align-center" style={{ gap: 10 }}>
                <MdiIcon name="timer-sand" size={20} className="text-primary" />
                <div className="flex-grow-1">
                  <div className="text-body-2">正在比对本地数据…</div>
                  {planProgress && (
                    <div className="text-caption text-medium-emphasis">
                      {planProgress.done} / {planProgress.total}
                    </div>
                  )}
                </div>
              </div>
              <div
                className={`v-progress-linear ${
                  planProgress && planProgress.total > 0 ? '' : 'v-progress-linear--indeterminate'
                }`}
                style={{ height: 6, borderRadius: 3, marginTop: 10 }}
              >
                <div
                  className="v-progress-linear__bar"
                  style={{
                    width:
                      planProgress && planProgress.total > 0
                        ? `${Math.min(100, (planProgress.done / planProgress.total) * 100)}%`
                        : undefined,
                  }}
                />
              </div>
            </div>
          ) : plan ? (
            <div className="import-plan">
              <div className="import-plan-summary">
                <div className="import-stat">
                  <span className="import-stat-value">{plan.rows.length}</span>
                  <span className="import-stat-label">总计</span>
                </div>
                {[
                  ['新增', plan.counts.new, 'success'],
                  ['覆盖', plan.counts.overwrite, 'warning'],
                  ['跳过', plan.counts.skip, 'grey'],
                  ['错误', plan.counts.error, 'error'],
                ].map(([label, count, color]) => (
                  <div className="import-stat" key={String(label)}>
                    <span className={`import-stat-value text-${color}`}>{String(count)}</span>
                    <span className="import-stat-label">{String(label)}</span>
                  </div>
                ))}
                <div className="import-stat">
                  <span className="import-stat-value">{formatBytes(plan.totalBytes)}</span>
                  <span className="import-stat-label">预计写入</span>
                </div>
              </div>

              {plan.warningCount > 0 && (
                <div className="v-alert v-alert--variant-tonal import-alert" data-color="warning">
                  <MdiIcon name="alert-circle-outline" size={20} />
                  <div>预览中有 {plan.warningCount} 条提示，请在导入前查看。</div>
                </div>
              )}

              <div className="import-plan-toolbar">
                <div className="import-plan-filters">
                  {(
                    [
                      ['all', `全部 ${plan.rows.length}`],
                      ['change', `将变更 ${plan.counts.new + plan.counts.overwrite}`],
                      ['skip', `跳过 ${plan.counts.skip}`],
                      ['error', `错误 ${plan.counts.error}`],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={`admin-chip ${planFilter === value ? 'active' : ''}`}
                      onClick={() => {
                        setPlanFilter(value)
                        setPlanPage(0)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => setPlan(null)}
                  >
                    返回调整
                  </button>
                  {!result && (
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-flat"
                      data-color={overwriteCount > 0 ? 'warning' : 'primary'}
                      disabled={actionable === 0 || importing}
                      onClick={() => setConfirmOpen(true)}
                    >
                      <MdiIcon name="file-import-outline" size={16} />
                      开始导入 {actionable} 条
                    </button>
                  )}
                </div>
              </div>

              <div className="import-plan-table">
                <div className="import-plan-head">
                  <span>数据键</span>
                  <span>处理</span>
                  <span>本地</span>
                  <span>摘要</span>
                  <span>大小</span>
                </div>
                {pagedRows.map((row) => (
                  <button
                    type="button"
                    className="import-plan-row"
                    key={row.key}
                    onClick={() => setPreviewRow(row)}
                  >
                    <span className="import-plan-key">
                      <MdiIcon
                        name={CATEGORY_ICON[row.category]}
                        size={18}
                        className="text-medium-emphasis"
                      />
                      <span>
                        <b>{row.label}</b>
                        <small>{row.key}</small>
                        {row.reason && <small className="import-muted">{row.reason}</small>}
                      </span>
                    </span>
                    <span>
                      <span className={actionClass(row.action)}>{ACTION_LABEL[row.action]}</span>
                    </span>
                    <span className="import-muted">
                      {row.localExists
                        ? row.localUpdatedAt
                          ? relativeTime(row.localUpdatedAt)
                          : '已有'
                        : '无'}
                    </span>
                    <span className="import-plan-summary-cell">{row.summary}</span>
                    <span className="import-muted">{row.size ? formatBytes(row.size) : '—'}</span>
                  </button>
                ))}
                {pagedRows.length === 0 && (
                  <div className="admin-empty">该筛选下没有记录</div>
                )}
              </div>

              <div className="import-pagination">
                <span className="text-caption text-medium-emphasis">
                  共 {filteredRows.length} 条 · 第 {safePage + 1} / {pageCount} 页
                </span>
                <div className="d-flex" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                    disabled={safePage === 0}
                    onClick={() => setPlanPage((value) => Math.max(0, value - 1))}
                    aria-label="上一页预览"
                  >
                    <MdiIcon name="chevron-left" size={18} />
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPlanPage((value) => Math.min(pageCount - 1, value + 1))}
                    aria-label="下一页预览"
                  >
                    <MdiIcon name="chevron-right" size={18} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="import-generate">
              <div>
                <div className="text-body-2">
                  {parsed
                    ? `备份含 ${parsed.records.length} 条数据，等待与本地比对`
                    : '请先选择备份文件'}
                </div>
                <div className="text-caption text-medium-emphasis">
                  预览会读取本地同键数据用于比对，不会修改任何内容。
                </div>
              </div>
              <button
                type="button"
                className="v-btn v-btn--variant-flat"
                data-color="primary"
                disabled={!parsed || planLoading}
                onClick={() => void generatePlan()}
              >
                <MdiIcon name="eye" size={18} />
                生成导入预览
              </button>
            </div>
          )}

          {importing && progress && (
            <div className="import-progress-card import-progress-card--active">
              <div className="d-flex align-center" style={{ gap: 10 }}>
                <MdiIcon name="timer-sand" size={20} className="text-primary" />
                <div className="flex-grow-1">
                  <div className="text-body-2">
                    {progress.chunk === 0
                      ? `正在准备导入 ${progress.totalChunks} 批数据…`
                      : `正在导入第 ${progress.chunk} / ${progress.totalChunks} 批`}
                  </div>
                  <div className="text-caption text-medium-emphasis">
                    已写入 {progress.imported} 条
                    {progress.skipped ? ` · 跳过 ${progress.skipped} 条` : ''}
                    {progress.failed ? ` · 失败 ${progress.failed} 条` : ''}
                    {' · '}
                    {formatBytes(progress.bytes)}
                  </div>
                </div>
                <button
                  type="button"
                  className="v-btn v-btn--size-small v-btn--variant-text"
                  onClick={() => {
                    cancelRef.current = true
                  }}
                >
                  取消
                </button>
              </div>
              <div className="v-progress-linear" style={{ height: 6, borderRadius: 3, marginTop: 10 }}>
                <div
                  className="v-progress-linear__bar"
                  style={{
                    width: `${
                      progress.totalChunks
                        ? (progress.chunk / progress.totalChunks) * 100
                        : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          )}

          {result && (
            <div className="import-result">
              <div className="import-result-head">
                <span className="import-result-icon">
                  <MdiIcon
                    name={
                      result.failed.length
                        ? 'alert-circle-outline'
                        : result.cancelled
                          ? 'information-outline'
                          : 'check-circle'
                    }
                    size={24}
                  />
                </span>
                <div>
                  <div className="text-subtitle-1 font-weight-medium">
                    {result.cancelled
                      ? '导入已取消'
                      : result.failed.length
                        ? '导入完成（部分失败）'
                        : '导入完成'}
                  </div>
                  <div className="text-caption text-medium-emphasis">
                    写入 {result.imported} 条
                    {result.skipped ? ` · 跳过 ${result.skipped} 条` : ''}
                    {result.failed.length ? ` · 失败 ${result.failed.length} 条` : ''}
                    {' · '}
                    {formatBytes(result.bytes)} · {(result.durationMs / 1000).toFixed(1)} 秒
                  </div>
                </div>
                <div className="flex-grow-1" />
                <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => {
                      setResult(null)
                      setPlan(null)
                    }}
                  >
                    重新预览
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-flat"
                    data-color="primary"
                    onClick={onOpenData}
                  >
                    查看本地数据
                  </button>
                </div>
              </div>
              {auditWarning && (
                <div
                  className="v-alert v-alert--variant-tonal import-alert"
                  data-color="warning"
                  style={{ margin: '0 14px 14px' }}
                >
                  <MdiIcon name="alert-circle-outline" size={20} />
                  <div>{auditWarning}</div>
                </div>
              )}
              {result.failed.length > 0 && (
                <div className="import-result-failures">
                  {result.failed.slice(0, 100).map((failure) => (
                    <div key={failure.key}>
                      <span className="font-monospace">{failure.key}</span>
                      <span>{failure.message}</span>
                    </div>
                  ))}
                  {result.failed.length > 100 && (
                    <div className="text-caption text-medium-emphasis">
                      仅显示前 100 条失败记录
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="确认导入备份"
        text={
          <>
            将写入 <b>{actionable}</b> 条数据到本地
            {plan && <>（新增 {plan.counts.new}、覆盖 {plan.counts.overwrite}）</>}。
            {overwriteCount > 0 && (
              <span className="text-warning">
                {' '}
                其中 {overwriteCount} 条会覆盖本地同键数据，操作无法撤销。
              </span>
            )}
          </>
        }
        confirmText={importing ? '导入中…' : '开始导入'}
        confirmDisabled={importing}
        danger={overwriteCount > 0}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void executeImport()}
      />

      <Modal
        open={Boolean(previewRow)}
        onClose={() => setPreviewRow(null)}
        width={720}
        fullscreenOnMobile
        title={
          previewRow ? (
            <span className="d-flex align-center" style={{ gap: 8 }}>
              <MdiIcon name={CATEGORY_ICON[previewRow.category]} size={20} />
              <span className="text-truncate">{previewRow.label}</span>
              <span className={actionClass(previewRow.action)}>
                {ACTION_LABEL[previewRow.action]}
              </span>
            </span>
          ) : null
        }
        subtitle={
          previewRow
            ? `${IMPORT_CATEGORY_LABELS[previewRow.category]} · ${previewRow.key}`
            : undefined
        }
        footer={
          <>
            <div className="flex-grow-1" />
            <button
              type="button"
              className="v-btn v-btn--variant-text"
              onClick={() => setPreviewRow(null)}
            >
              关闭
            </button>
          </>
        }
      >
        {previewRow && (
          <div className="import-preview">
            <div className="import-preview-meta">
              <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                备份 {previewRow.backupUpdatedAt ? formatTime(previewRow.backupUpdatedAt) : '未记录时间'}
              </span>
              <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                本地{' '}
                {previewRow.localExists
                  ? previewRow.localUpdatedAt
                    ? formatTime(previewRow.localUpdatedAt)
                    : '已有'
                  : '无'}
              </span>
              <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                {formatBytes(previewRow.size)}
              </span>
            </div>
            {previewRow.reason && (
              <div className="v-alert v-alert--variant-tonal import-alert" data-color="info">
                <MdiIcon name="information-outline" size={20} />
                <div>{previewRow.reason}</div>
              </div>
            )}
            {previewRow.action === 'skip' || previewRow.action === 'error' ? (
              <div className="admin-empty">
                {previewRow.summary}
                <div className="text-caption text-medium-emphasis mt-1">该条不会被写入</div>
              </div>
            ) : (
              <div className="import-preview-section">
                <div className="import-preview-title">{previewRow.summary}</div>
                <pre className="import-json">{prettyJson(previewRow.value)}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

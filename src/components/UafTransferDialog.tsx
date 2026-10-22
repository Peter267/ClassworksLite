import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Modal } from './ui/Modal'
import { toDateKey, today } from '../lib/date'
import { getClient } from '../lib/kv'
import { getSetting } from '../lib/settings'
import { store } from '../lib/store'
import { toast } from '../lib/toast'
import type { BoardData, Subject } from '../lib/types'
import {
  buildUafPdfBytes,
  createExportPreview,
  createImportPlan,
  downloadUafAssignments,
  executeImportPlan,
  findImportPlanIssues,
  itemsFromBoardData,
  parseUafPdf,
  UafExportValidationError,
  type ExportRow,
  type ImportPlan,
  type ImportRow,
  type UafStyle,
} from '../lib/uafExport'

interface UafTransferDialogProps {
  open: boolean
  mode: 'export' | 'import'
  currentDate: string
  subjects: Subject[]
  onClose: () => void
  onImported: () => void
}

const FONT_WEIGHT_OPTIONS: { title: string; value: 'light' | 'regular' | 'bold' }[] = [
  { title: 'Light', value: 'light' },
  { title: 'Regular', value: 'regular' },
  { title: 'Bold', value: 'bold' },
]

const STYLE_FIELDS = [
  { key: 'subject' as const, label: '标题', min: 10, max: 32 },
  { key: 'content' as const, label: '正文', min: 8, max: 24 },
  { key: 'tags' as const, label: '标签', min: 6, max: 16 },
]

const EMPTY_BOARD: BoardData = { homework: {}, attendance: { absent: [], late: [], exclude: [] } }

function displayDate(date: string) {
  if (/^\d{8}$/.test(date)) return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
  return date
}

function cloneBoard(board: BoardData): BoardData {
  return JSON.parse(JSON.stringify(board)) as BoardData
}

export function UafTransferDialog({
  open,
  mode,
  currentDate,
  subjects,
  onClose,
  onImported,
}: UafTransferDialogProps) {
  const [exportDate, setExportDate] = useState(displayDate(currentDate))
  const [rows, setRows] = useState<ExportRow[]>([])
  const [exportError, setExportError] = useState('')
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null)
  const [importError, setImportError] = useState('')
  const [loadingImport, setLoadingImport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [styleOpen, setStyleOpen] = useState(false)
  const [globalStyle, setGlobalStyle] = useState<UafStyle>({
    subject: { fontSize: 17, fontWeight: 'regular' },
    content: { fontSize: 13.5, fontWeight: 'regular' },
    tags: { fontSize: 9.5, fontWeight: 'regular' },
  })
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>({})
  const previewTimer = useRef<number | null>(null)
  const previewUrlRef = useRef('')
  /** 异步读取/解析序号：旧请求后返回时不得覆盖新选择（F19） */
  const exportSeq = useRef(0)
  const importSeq = useRef(0)
  const previewSeq = useRef(0)

  const selectedAssignments = useMemo(
    () => rows.filter((row) => row.selected).map((row) => row.assignment),
    [rows],
  )
  const styledAssignments = useMemo(
    () =>
      selectedAssignments.map((assignment) => ({
        ...assignment,
        style: JSON.parse(JSON.stringify(globalStyle)),
      })),
    [selectedAssignments, globalStyle],
  )
  const validRows = useMemo(() => rows.filter((row) => row.issues.length === 0), [rows])
  const allValidSelected = validRows.length > 0 && validRows.every((row) => row.selected)
  const someValidSelected = validRows.some((row) => row.selected)

  const groupedRows = useMemo(() => {
    if (!importPlan) return []
    const groups = new Map<string, ImportRow[]>()
    for (const row of importPlan.rows) {
      const list = groups.get(row.date) ?? []
      list.push(row)
      groups.set(row.date, list)
    }
    return [...groups.entries()].map(([date, groupRows]) => ({ date, rows: groupRows }))
  }, [importPlan])

  const planIssues = useMemo(() => findImportPlanIssues(importPlan?.rows ?? []), [importPlan])

  const releasePreviewUrl = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = ''
      setPreviewUrl('')
    }
  }, [])

  const loadBoard = useCallback(
    async (date: string): Promise<{ board: BoardData; updatedAt: number | null }> => {
      if (date === currentDate) {
        const snapshot = store.getSnapshot()
        return { board: cloneBoard(snapshot.board), updatedAt: snapshot.updatedAt }
      }
      const entry = await getClient().get<BoardData>(`classworks-data-${date}`)
      return {
        board: entry ? cloneBoard(entry.value) : cloneBoard(EMPTY_BOARD),
        updatedAt: entry?.updatedAt ?? null,
      }
    },
    [currentDate],
  )

  const loadExportPreview = useCallback(
    async (dateValue: string) => {
      if (!dateValue) return
      const seq = (exportSeq.current += 1)
      setLoadingPreview(true)
      setExportError('')
      try {
        const date = dateValue.replaceAll('-', '')
        const loaded = await loadBoard(date)
        const items = itemsFromBoardData(loaded.board, subjects)
        if (seq !== exportSeq.current) return
        setRows(createExportPreview(items, dateValue))
      } catch (error) {
        if (seq !== exportSeq.current) return
        setRows([])
        setExportError(error instanceof Error ? error.message : '无法加载该日期的作业')
      } finally {
        if (seq === exportSeq.current) setLoadingPreview(false)
      }
    },
    [currentDate, loadBoard, subjects],
  )

  /* 打开时初始化 */
  useEffect(() => {
    if (!open) {
      // 关闭后让在途请求失效，避免弹窗重开时被旧结果覆盖
      exportSeq.current += 1
      importSeq.current += 1
      releasePreviewUrl()
      return
    }
    if (mode === 'export') {
      const nextDate = displayDate(currentDate)
      setExportDate(nextDate)
      void loadExportPreview(nextDate)
    } else {
      setImportFile(null)
      setImportPlan(null)
      setImportError('')
    }
  }, [open, mode, currentDate, loadExportPreview, releasePreviewUrl])

  /* 生成 PDF 预览（防抖 800ms）；旧构建晚返回时直接丢弃 */
  useEffect(() => {
    const seq = (previewSeq.current += 1)
    if (!open || mode !== 'export') {
      setPreviewLoading(false)
      return
    }
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    if (styledAssignments.length === 0) {
      releasePreviewUrl()
      setPreviewError('')
      setPreviewLoading(false)
      return
    }
    setPreviewLoading(true)
    setPreviewError('')
    previewTimer.current = window.setTimeout(async () => {
      try {
        const pdfBytes = await buildUafPdfBytes(styledAssignments)
        if (seq !== previewSeq.current) return
        const blob = new Blob([pdfBytes as BlobPart], { type: 'application/pdf' })
        releasePreviewUrl()
        const url = URL.createObjectURL(blob)
        previewUrlRef.current = url
        setPreviewUrl(url)
      } catch (error) {
        if (seq !== previewSeq.current) return
        releasePreviewUrl()
        setPreviewError(formatError(error))
      } finally {
        if (seq === previewSeq.current) setPreviewLoading(false)
      }
    }, 800)
    return () => {
      if (previewTimer.current) window.clearTimeout(previewTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styledAssignments, open, mode])

  useEffect(() => () => releasePreviewUrl(), [releasePreviewUrl])

  const toggleAll = () => {
    const selected = !allValidSelected
    setRows((current) =>
      current.map((row) => (row.issues.length === 0 ? { ...row, selected } : row)),
    )
  }

  const setFontSize = (key: keyof UafStyle, raw: string) => {
    const field = STYLE_FIELDS.find((item) => item.key === key)!
    const parsed = Number(raw)
    const size = Number.isFinite(parsed) ? parsed : field.min
    const clamped = Math.round(Math.min(field.max, Math.max(field.min, size)) * 2) / 2
    setGlobalStyle((current) => ({ ...current, [key]: { ...current[key], fontSize: clamped } }))
  }

  const doExport = async () => {
    if (busy || selectedAssignments.length === 0) return
    setBusy(true)
    try {
      const filename = await downloadUafAssignments(styledAssignments, exportDate)
      toast.success('导出成功', filename)
      onClose()
    } catch (error) {
      toast.error('导出失败', formatError(error))
    } finally {
      setBusy(false)
    }
  }

  const prepareImport = async (file: File | null) => {
    const seq = (importSeq.current += 1)
    setImportFile(file)
    setImportPlan(null)
    setImportError('')
    if (!file) return
    setLoadingImport(true)
    try {
      const document = await parseUafPdf(file)
      if (seq !== importSeq.current) return
      const plan = await createImportPlan(document, subjects, loadBoard)
      if (seq !== importSeq.current) return
      setImportPlan(plan)
    } catch (error) {
      if (seq !== importSeq.current) return
      setImportError(formatError(error))
    } finally {
      if (seq === importSeq.current) setLoadingImport(false)
    }
  }

  const doImport = async () => {
    if (!importPlan || busy) return
    const activeRows = importPlan.rows.filter((row) => row.action !== 'keep')
    const activeDates = [...new Set(activeRows.map((row) => row.date))]
    const todayKey = toDateKey(today())
    if (getSetting<boolean>('edit.blockPastDataEdit') && activeDates.some((date) => date < todayKey)) {
      toast.warning('不能导入历史日期', '设置中已禁止编辑过往数据')
      return
    }
    if (
      getSetting<boolean>('edit.confirmNonTodaySave') &&
      activeDates.some((date) => date !== todayKey) &&
      typeof window.confirm === 'function' &&
      !window.confirm('导入包含非当天日期，确定继续吗？')
    ) {
      return
    }

    setBusy(true)
    try {
      const result = await executeImportPlan(importPlan, async (date, board) => {
        await getClient().set(`classworks-data-${date}`, board, {
          baseUpdatedAt: importPlan.versions.get(date) ?? null,
        })
      })
      onImported()
      if (result.failedDates.length) {
        // 已成功的日期标记为保留，重试时只处理失败日期，避免重复写入/创建卡片
        setImportPlan((current) =>
          current
            ? {
                ...current,
                rows: current.rows.map((row) =>
                  result.savedDates.includes(row.date) ? { ...row, action: 'keep' as const } : row,
                ),
              }
            : current,
        )
        toast.warning(
          '部分日期导入失败',
          `已保存：${result.savedDates.join('、') || '无'}\n失败：${result.failedDates
            .map((item) => item.date)
            .join('、')}`,
        )
      } else {
        toast.success('导入完成', `已导入 ${result.imported} 项，保留 ${result.skipped} 项`)
        onClose()
      }
    } catch (error) {
      toast.error('导入失败', formatError(error))
    } finally {
      setBusy(false)
    }
  }

  const footerText = (() => {
    if (mode === 'export') return `文件日期：${exportDate || '未选择'}`
    if (!importPlan) return '仅支持由本工具导出的 UAF PDF'
    const active = importPlan.rows.filter((row) => row.action !== 'keep').length
    return `将导入 ${active} 项，保留 ${importPlan.rows.length - active} 项`
  })()

  const primaryDisabled =
    mode === 'export'
      ? selectedAssignments.length === 0 || loadingPreview || busy
      : !importPlan || planIssues.length > 0 || busy

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={920}
      fullscreenOnMobile
      bare
      title={
        <>
          <Icon name={mode === 'export' ? 'fileExport' : 'fileImport'} size={22} className="mr-2" />
          {mode === 'export' ? '导出 UAF' : '导入 UAF'}
        </>
      }
      footer={
        <>
          <span className="text-caption text-medium-emphasis" style={{ marginLeft: 8 }}>
            {footerText}
          </span>
          <div className="flex-grow-1" />
          <button type="button" className="v-btn v-btn--variant-text" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="v-btn v-btn--variant-flat"
            data-color="primary"
            disabled={primaryDisabled}
            onClick={() => void (mode === 'export' ? doExport() : doImport())}
          >
            <Icon name={mode === 'export' ? 'download' : 'databaseImport'} size={18} />
            {mode === 'export' ? '导出所选作业' : '确认导入'}
          </button>
        </>
      }
    >
      <div className="uaf-content">
        {mode === 'export' ? (
          <div className="uaf-export-layout">
            <div className="uaf-editor-section">
              <label className="v-label">导出日期</label>
              <div className="v-field" style={{ marginBottom: 12, paddingLeft: 12 }}>
                <Icon name="calendar" size={18} className="text-medium-emphasis mr-2" />
                <input
                  type="date"
                  value={exportDate}
                  disabled={busy}
                  onChange={(event) => {
                    setExportDate(event.target.value)
                    void loadExportPreview(event.target.value)
                  }}
                  style={{
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    height: 38,
                  }}
                />
              </div>

              {loadingPreview && (
                <div className="v-progress-linear v-progress-linear--indeterminate mb-3">
                  <div className="v-progress-linear__bar" />
                </div>
              )}

              {exportError && (
                <div className="v-alert v-alert--variant-tonal mb-3" data-color="warning">
                  {exportError}
                </div>
              )}

              {rows.length > 0 && (
                <div className="d-flex align-center mb-2">
                  <input
                    type="checkbox"
                    checked={allValidSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = someValidSelected && !allValidSelected
                    }}
                    onChange={toggleAll}
                    style={{ width: 18, height: 18, marginRight: 8 }}
                    aria-label="选择全部有效作业"
                  />
                  <span className="text-body-2">选择全部有效作业</span>
                  <div className="flex-grow-1" />
                  <span className="text-caption text-medium-emphasis">
                    已选择 {selectedAssignments.length} / {rows.length} 项
                  </span>
                </div>
              )}

              {rows.length > 0 ? (
                <div className="v-list uaf-rows">
                  {rows.map((row, index) => (
                    <div className="v-list-item uaf-row" key={row.id}>
                      <input
                        type="checkbox"
                        checked={row.selected}
                        disabled={row.issues.length > 0}
                        onChange={(event) =>
                          setRows((current) =>
                            current.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, selected: event.target.checked } : item,
                            ),
                          )
                        }
                        style={{ width: 18, height: 18, marginRight: 12, marginTop: 2 }}
                      />
                      <div className="flex-grow-1" style={{ minWidth: 0 }}>
                        <div className="v-list-item-title">{row.assignment.subject}</div>
                        <div className="v-list-item-subtitle uaf-content-preview">
                          {row.assignment.content}
                        </div>
                        <div className="d-flex flex-wrap align-center mt-1" style={{ gap: 4 }}>
                          <span className="v-chip v-chip--size-x-small v-chip--variant-tonal">
                            {row.assignment.date}
                          </span>
                          {row.assignment.tags.map((tag) => (
                            <span
                              key={tag}
                              className="v-chip v-chip--size-x-small v-chip--variant-tonal"
                              data-color="primary"
                            >
                              {tag}
                            </span>
                          ))}
                          {row.issues.length > 0 && (
                            <span className="text-caption text-error">{row.issues.join('；')}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                !loadingPreview &&
                !exportError && (
                  <div className="text-center text-medium-emphasis" style={{ padding: '32px 0' }}>
                    <Icon name="book" size={32} className="mb-2" />
                    <div className="text-body-2">暂无作业</div>
                    <div className="text-caption">该日期没有可导出的作业</div>
                  </div>
                )
              )}
            </div>

            <div className="uaf-preview-section">
              <div className="uaf-preview-placeholder">
                <div className="uaf-preview-scroll">
                  {previewLoading ? (
                    <div className="v-progress-linear v-progress-linear--indeterminate">
                      <div className="v-progress-linear__bar" />
                    </div>
                  ) : previewError ? (
                    <div className="v-alert v-alert--variant-tonal" data-color="error">
                      {previewError}
                    </div>
                  ) : !previewUrl ? (
                    <div className="v-alert v-alert--variant-tonal" data-color="info">
                      请选择有效作业以预览
                    </div>
                  ) : (
                    <iframe src={previewUrl} className="uaf-pdf-frame" title="UAF 导出预览" />
                  )}
                </div>
              </div>

              <div className="v-card border mt-3">
                <button
                  type="button"
                  className="v-list-item"
                  onClick={() => setStyleOpen((open) => !open)}
                  style={{ width: '100%', justifyContent: 'space-between' }}
                >
                  <span className="text-body-2 font-weight-medium">导出字体设置</span>
                  <Icon name={styleOpen ? 'up' : 'down'} size={18} />
                </button>
                {styleOpen && (
                  <div style={{ padding: 12 }}>
                    {STYLE_FIELDS.map((field) => (
                      <div key={field.key} style={{ marginBottom: 12 }}>
                        <div className="d-flex align-center" style={{ gap: 12 }}>
                          <span className="text-caption" style={{ minWidth: 40, textAlign: 'right' }}>
                            {field.label}
                          </span>
                          <input
                            className="v-slider flex-grow-1"
                            type="range"
                            min={field.min}
                            max={field.max}
                            step={0.5}
                            value={globalStyle[field.key].fontSize}
                            onChange={(event) => setFontSize(field.key, event.target.value)}
                          />
                          <input
                            className="v-field v-field--density-compact"
                            type="number"
                            min={field.min}
                            max={field.max}
                            step={0.5}
                            value={globalStyle[field.key].fontSize}
                            onChange={(event) => setFontSize(field.key, event.target.value)}
                            style={{ maxWidth: 90 }}
                          />
                        </div>
                        <div className="d-flex align-center mt-2" style={{ gap: 12 }}>
                          <span className="text-caption" style={{ minWidth: 40, textAlign: 'right' }}>
                            字重
                          </span>
                          <select
                            className="v-field v-field--density-compact"
                            value={globalStyle[field.key].fontWeight}
                            onChange={(event) =>
                              setGlobalStyle((current) => ({
                                ...current,
                                [field.key]: {
                                  ...current[field.key],
                                  fontWeight: event.target.value as 'light' | 'regular' | 'bold',
                                },
                              }))
                            }
                            style={{ maxWidth: 110 }}
                          >
                            {FONT_WEIGHT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ padding: '0 4px' }}>
            <div className="d-flex align-center flex-wrap" style={{ gap: 12 }}>
              <label className="v-btn v-btn--variant-outlined" style={{ cursor: 'pointer' }}>
                <Icon name="fileDocument" size={18} />
                选择 UAF PDF
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  disabled={busy}
                  onChange={(event) => void prepareImport(event.target.files?.[0] ?? null)}
                  style={{ display: 'none' }}
                />
              </label>
              <span className="text-body-2 text-medium-emphasis">
                {importFile ? importFile.name : '未选择任何文件'}
              </span>
            </div>

            {loadingImport && (
              <div className="v-progress-linear v-progress-linear--indeterminate mt-3">
                <div className="v-progress-linear__bar" />
              </div>
            )}

            {importError && (
              <div className="v-alert v-alert--variant-tonal mt-3" data-color="error">
                {importError}
              </div>
            )}

            {planIssues.length > 0 && (
              <div className="v-alert v-alert--variant-tonal mt-3" data-color="warning">
                {planIssues.join('；')}
              </div>
            )}

            {importPlan && (
              <>
                <div className="text-body-2 mt-3 mb-3">
                  共 {importPlan.rows.length} 项作业，分布在 {groupedRows.length} 个日期。
                  冲突项默认保留现有内容。
                </div>
                {groupedRows.map((group) => (
                  <div className="v-card border mb-2" key={group.date}>
                    <button
                      type="button"
                      className="v-list-item"
                      style={{ width: '100%', minHeight: 48 }}
                      onClick={() =>
                        setExpandedDates((current) => ({
                          ...current,
                          [group.date]: !current[group.date],
                        }))
                      }
                    >
                      <span className="v-list-item-title">{displayDate(group.date)}</span>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal ml-2">
                        {group.rows.length} 项
                      </span>
                      <div className="flex-grow-1" />
                      <Icon name={expandedDates[group.date] ? 'up' : 'down'} size={18} />
                    </button>
                    {expandedDates[group.date] && (
                      <div style={{ borderTop: '1px solid rgba(var(--v-border-color), var(--v-border-opacity))' }}>
                        {group.rows.map((row) => (
                          <div className="uaf-import-row" key={row.id}>
                            <div className="flex-grow-1" style={{ minWidth: 0 }}>
                              <div className="d-flex align-center flex-wrap">
                                <span className="v-list-item-title">{row.assignment.subject}</span>
                                {row.conflict && (
                                  <span
                                    className="v-chip v-chip--size-x-small v-chip--variant-tonal ml-2"
                                    data-color="warning"
                                  >
                                    已有同名卡片
                                  </span>
                                )}
                              </div>
                              <div className="v-list-item-subtitle uaf-content-preview">
                                {row.assignment.content}
                              </div>
                            </div>
                            <select
                              className="v-field v-field--density-compact"
                              value={row.action}
                              onChange={(event) =>
                                setImportPlan((current) =>
                                  current
                                    ? {
                                        ...current,
                                        rows: current.rows.map((item) =>
                                          item.id === row.id
                                            ? { ...item, action: event.target.value as ImportRow['action'] }
                                            : item,
                                        ),
                                      }
                                    : current,
                                )
                              }
                              style={{ width: 132, marginLeft: 12 }}
                            >
                              {(row.conflict
                                ? [
                                    { title: '保留现有', value: 'keep' },
                                    { title: '覆盖现有', value: 'overwrite' },
                                  ]
                                : [
                                    { title: '导入', value: 'import' },
                                    { title: '跳过', value: 'keep' },
                                  ]
                              ).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.title}
                                </option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

function formatError(error: unknown) {
  if (error instanceof UafExportValidationError) return error.issues.join('\n')
  return error instanceof Error ? error.message : '发生未知错误'
}

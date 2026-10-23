import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { MdiIcon } from '../MdiIcon'
import { ConfirmDialog, Modal } from '../ui/Modal'
import { AdminError, adminApi, type AdminKeyInfo } from '../../lib/admin'
import { relativeTime } from '../../lib/date'
import { toast } from '../../lib/toast'
import {
  boardDateFromKey,
  buildImportPlan,
  chunkImportRecords,
  classifyKey,
  configDescription,
  DEFAULT_UPSTREAM_SERVER,
  fetchUpstreamConnectionInfo,
  fetchUpstreamKeys,
  importLabelFor,
  IMPORT_CATEGORY_LABELS,
  KNOWN_CONFIG_KEYS,
  loadUpstreamValues,
  normalizeBoardValue,
  normalizeExams,
  normalizeNoiseConfig,
  normalizeStudents,
  normalizeSubjects,
  normalizeTemplate,
  normalizeBaseUrl,
  UpstreamError,
  type ConflictStrategy,
  type ImportCategory,
  type ImportPlan,
  type ImportPlanRow,
  type ImportSelection,
  type LocalRecord,
  type UpstreamAuth,
  type UpstreamConnectionInfo,
  type UpstreamKeyInfo,
  type ValueLoadResult,
} from '../../lib/upstreamImport'
import type { BoardData, ExamConfig } from '../../lib/types'

interface ImportResult {
  imported: number
  skipped: number
  failed: { key: string; message: string }[]
  bytes: number
  chunks: number
  durationMs: number
  cancelled?: boolean
}

interface BoardItem {
  key: string
  date: Date
  iso: string
  updatedAt: number
}

const BOARD_PAGE_SIZE = 30
const PLAN_PAGE_SIZE = 40
const CATEGORY_ICON: Record<ImportCategory, string> = {
  board: 'calendar-check',
  students: 'school',
  subjects: 'notebook',
  exams: 'calendar',
  template: 'text-box-outline',
  noise: 'microphone',
  other: 'database',
}

const ACTION_LABEL: Record<ImportPlanRow['action'], string> = {
  new: '新增',
  overwrite: '覆盖',
  merge: '合并',
  skip: '跳过',
  error: '错误',
}

const TOKEN_TYPE_LABEL: Record<string, string> = {
  teacher: '教师令牌',
  classroom: '教室令牌',
  student: '学生令牌',
  parent: '家长令牌',
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function isoOf(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateLabel(date: Date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function weekdayLabel(date: Date) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()]
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : '未知错误'
}

function roleName(info: UpstreamConnectionInfo | null) {
  if (!info) return '未知命名空间'
  return (
    info.account?.name ||
    info.device?.name ||
    info.device?.namespace ||
    info.device?.uuid ||
    'Classworks 云端'
  )
}

function actionClass(action: ImportPlanRow['action']) {
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

export function UpstreamImportPanel({
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
  const [baseUrl, setBaseUrl] = useState(DEFAULT_UPSTREAM_SERVER)
  const [tokenInput, setTokenInput] = useState('')
  const [siteKeyInput, setSiteKeyInput] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [connection, setConnection] = useState<{
    auth: UpstreamAuth
    info: UpstreamConnectionInfo
  } | null>(null)
  const [remoteKeys, setRemoteKeys] = useState<UpstreamKeyInfo[]>([])
  const [keyListInfo, setKeyListInfo] = useState<{ total: number; truncated: boolean } | null>(
    null,
  )
  const [localKeyMap, setLocalKeyMap] = useState<Map<string, number>>(new Map())
  const [localKeysTruncated, setLocalKeysTruncated] = useState(false)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [boardQuery, setBoardQuery] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [boardPage, setBoardPage] = useState(0)
  const [showOthers, setShowOthers] = useState(false)
  const [strategy, setStrategy] = useState<ConflictStrategy>('merge')
  const [skipEmptyBoards, setSkipEmptyBoards] = useState(true)

  const remoteCache = useRef(new Map<string, unknown>())
  const remoteErrorsRef = useRef(new Map<string, string>())
  const remoteLoadedRef = useRef(new Set<string>())
  const localCacheRef = useRef(new Map<string, LocalRecord>())
  const localLoadedRef = useRef(new Set<string>())
  const planAbortRef = useRef<AbortController | null>(null)

  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planStage, setPlanStage] = useState('')
  const [planProgress, setPlanProgress] = useState<{ done: number; total: number } | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  const [planFilter, setPlanFilter] = useState<'all' | 'change' | 'skip' | 'error'>('all')
  const [planPage, setPlanPage] = useState(0)
  const [previewRow, setPreviewRow] = useState<ImportPlanRow | null>(null)
  const planSectionRef = useRef<HTMLDivElement | null>(null)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{
    chunk: number
    totalChunks: number
    imported: number
    skipped: number
    failed: number
    bytes: number
  } | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [auditWarning, setAuditWarning] = useState<string | null>(null)
  const importCancelRef = useRef(false)

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

  const loadLocalKeys = useCallback(async () => {
    try {
      const result = await adminApi.keys(adminToken)
      setLocalKeyMap(new Map(result.keys.map((item: AdminKeyInfo) => [item.key, item.updatedAt])))
      setLocalKeysTruncated(result.truncated)
    } catch {
      // 本地状态仅作提示；预览阶段会用 get_many 精确比对
    }
  }, [adminToken])

  useEffect(() => {
    void loadLocalKeys()
  }, [loadLocalKeys])

  const remoteKeyMap = useMemo(
    () => new Map(remoteKeys.map((item) => [item.key, item])),
    [remoteKeys],
  )

  const boards = useMemo<BoardItem[]>(() => {
    return remoteKeys
      .filter((item) => classifyKey(item.key) === 'board')
      .map((item) => {
        const date = boardDateFromKey(item.key)
        if (!date) return null
        return { key: item.key, date, iso: isoOf(date), updatedAt: item.updatedAt }
      })
      .filter((item): item is BoardItem => Boolean(item))
      .sort((a, b) => b.key.localeCompare(a.key))
  }, [remoteKeys])

  const latestBoard = boards[0] ?? null
  const configKeys = KNOWN_CONFIG_KEYS.map((key) => ({
    key,
    remote: remoteKeyMap.get(key) ?? null,
    label: importLabelFor(key),
    description: configDescription(key),
    category: classifyKey(key),
  }))
  const otherKeys = useMemo(
    () =>
      remoteKeys
        .filter((item) => classifyKey(item.key) === 'other')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [remoteKeys],
  )
  const configPresent = configKeys.filter((item) => item.remote)
  const selectedConfigCount = configPresent.filter((item) => selected.has(item.key)).length
  const selectedBoardCount = boards.filter((item) => selected.has(item.key)).length
  const selectedOtherCount = otherKeys.filter((item) => selected.has(item.key)).length

  const filteredBoards = useMemo(() => {
    const keyword = boardQuery.trim().toLowerCase()
    return boards.filter((item) => {
      if (fromDate && item.iso < fromDate) return false
      if (toDate && item.iso > toDate) return false
      if (!keyword) return true
      return (
        item.key.toLowerCase().includes(keyword) ||
        item.iso.includes(keyword) ||
        dateLabel(item.date).includes(keyword)
      )
    })
  }, [boards, boardQuery, fromDate, toDate])

  const boardPageCount = Math.max(1, Math.ceil(filteredBoards.length / BOARD_PAGE_SIZE))
  const safeBoardPage = Math.min(boardPage, boardPageCount - 1)
  const pagedBoards = filteredBoards.slice(
    safeBoardPage * BOARD_PAGE_SIZE,
    safeBoardPage * BOARD_PAGE_SIZE + BOARD_PAGE_SIZE,
  )
  const allFilteredSelected =
    filteredBoards.length > 0 && filteredBoards.every((item) => selected.has(item.key))

  useEffect(() => {
    setBoardPage(0)
  }, [boardQuery, fromDate, toDate])

  const invalidatePlan = useCallback(() => {
    setPlan(null)
    setPlanError(null)
    setImportResult(null)
  }, [])

  const commitSelection = useCallback(
    (updater: (current: Set<string>) => Set<string>) => {
      setSelected((current) => updater(new Set(current)))
      invalidatePlan()
    },
    [invalidatePlan],
  )

  const toggleKey = useCallback(
    (key: string) => {
      commitSelection((current) => {
        if (current.has(key)) current.delete(key)
        else current.add(key)
        return current
      })
    },
    [commitSelection],
  )

  const replaceBoardSelection = useCallback(
    (keys: string[]) => {
      commitSelection((current) => {
        for (const key of boards) current.delete(key.key)
        for (const key of keys) current.add(key)
        return current
      })
    },
    [boards, commitSelection],
  )

  const selectRecentBoards = useCallback(
    (days: number) => {
      if (!latestBoard) {
        toast.info('云端没有作业数据', '请确认该命名空间已有作业记录')
        return
      }
      const start = new Date(latestBoard.date)
      start.setDate(start.getDate() - (days - 1))
      const selectedKeys = boards
        .filter((item) => item.date >= start)
        .map((item) => item.key)
      replaceBoardSelection(selectedKeys)
    },
    [boards, latestBoard, replaceBoardSelection],
  )

  const resetCaches = useCallback(() => {
    remoteCache.current.clear()
    remoteErrorsRef.current.clear()
    remoteLoadedRef.current.clear()
    localCacheRef.current.clear()
    localLoadedRef.current.clear()
  }, [])

  const resetConnection = () => {
    planAbortRef.current?.abort()
    setConnection(null)
    setRemoteKeys([])
    setKeyListInfo(null)
    setSelected(new Set())
    resetCaches()
    setPlan(null)
    setPlanError(null)
    setImportResult(null)
    setConnectError(null)
    setBoardQuery('')
    setFromDate('')
    setToDate('')
    setShowOthers(false)
  }

  async function connect() {
    if (connecting) return
    setConnectError(null)
    let auth: UpstreamAuth
    try {
      const normalized = normalizeBaseUrl(baseUrl)
      const token = tokenInput.trim()
      const siteKey = siteKeyInput.trim()
      if (!token && !siteKey) {
        throw new UpstreamError(0, 'missing_token', '请填写 App Token 或旧版 Site Key')
      }
      auth = {
        baseUrl: normalized,
        token: token || undefined,
        siteKey: siteKey || undefined,
      }
    } catch (err) {
      setConnectError(errorMessage(err))
      return
    }

    setConnecting(true)
    try {
      const [info, keyList] = await Promise.all([
        fetchUpstreamConnectionInfo(auth),
        fetchUpstreamKeys(auth),
      ])
      const present = new Set(keyList.keys.map((item) => item.key))
      const defaults = KNOWN_CONFIG_KEYS.filter((key) => present.has(key))
      setConnection({ auth, info })
      setRemoteKeys(keyList.keys)
      setKeyListInfo({ total: keyList.total, truncated: keyList.truncated })
      setSelected(new Set(defaults))
      resetCaches()
      setPlan(null)
      setPlanError(null)
      setImportResult(null)
      setBoardQuery('')
      setFromDate('')
      setToDate('')
      setShowOthers(false)
      toast.success('云端连接成功', `发现 ${keyList.keys.length} 个数据键`)
    } catch (err) {
      setConnectError(errorMessage(err))
    } finally {
      setConnecting(false)
    }
  }

  function cancelPlan() {
    planAbortRef.current?.abort()
    setPlanLoading(false)
    setPlanStage('')
    setPlanProgress(null)
  }

  async function generatePlan() {
    if (!connection || selected.size === 0 || planLoading) return
    const selections: ImportSelection[] = [...selected].map((key) => ({
      key,
      category: classifyKey(key),
      remoteUpdatedAt: remoteKeyMap.get(key)?.updatedAt ?? 0,
    }))
    selections.sort((a, b) => a.key.localeCompare(b.key))

    setPlanLoading(true)
    setPlan(null)
    setPlanError(null)
    setImportResult(null)
    setAuditWarning(null)
    setPlanStage('准备数据')
    setPlanProgress(null)
    const controller = new AbortController()
    planAbortRef.current = controller

    try {
      const missingRemote = selections
        .map((item) => item.key)
        .filter((key) => !remoteLoadedRef.current.has(key))
      if (missingRemote.length) {
        setPlanStage('读取云端数据')
        setPlanProgress({ done: 0, total: missingRemote.length })
        let result: ValueLoadResult
        try {
          result = await loadUpstreamValues(
            connection.auth,
            missingRemote,
            (done, total) => setPlanProgress({ done, total }),
            controller.signal,
          )
        } catch (err) {
          if (controller.signal.aborted) return
          throw err
        }
        for (const [key, value] of result.values) remoteCache.current.set(key, value)
        for (const [key, message] of result.errors) remoteErrorsRef.current.set(key, message)
        for (const key of missingRemote) remoteLoadedRef.current.add(key)
      }

      if (controller.signal.aborted) return
      const missingLocal = selections
        .map((item) => item.key)
        .filter((key) => !localLoadedRef.current.has(key))
      if (missingLocal.length) {
        setPlanStage('比对本地数据')
        setPlanProgress({ done: 0, total: missingLocal.length })
        let localDone = 0
        const processLocalChunk = async (chunk: string[]): Promise<void> => {
          if (controller.signal.aborted) return
          try {
            const result = await adminApi.getMany(adminToken, chunk)
            for (const record of result.records) {
              localLoadedRef.current.add(record.key)
              if (record.found) {
                localCacheRef.current.set(record.key, {
                  value: record.value,
                  updatedAt: record.updatedAt ?? 0,
                })
              }
            }
          } catch (err) {
            if (handleAdminError(err)) throw err
            // 单条数据很大时 get_many 会因响应体积被拒，自动二分重试
            if (err instanceof AdminError && err.status === 413 && chunk.length > 1) {
              const middle = Math.ceil(chunk.length / 2)
              await processLocalChunk(chunk.slice(0, middle))
              await processLocalChunk(chunk.slice(middle))
              return
            }
            throw err
          }
          localDone += chunk.length
          setPlanProgress({ done: localDone, total: missingLocal.length })
        }
        for (let index = 0; index < missingLocal.length; index += 200) {
          await processLocalChunk(missingLocal.slice(index, index + 200))
        }
      }

      if (controller.signal.aborted) return
      const localKeys = new Map(
        [...localCacheRef.current.entries()].map(([key, record]) => [key, record.updatedAt]),
      )
      const nextPlan = buildImportPlan(
        selections,
        remoteCache.current,
        remoteErrorsRef.current,
        {
          strategy,
          skipEmptyBoards,
          localKeys,
          localRecords: localCacheRef.current,
        },
      )
      setPlan(nextPlan)
      setPlanFilter('all')
      setPlanPage(0)
      window.setTimeout(() => {
        planSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 60)
    } catch (err) {
      if (handleAdminError(err)) return
      if (!controller.signal.aborted) {
        setPlanError(errorMessage(err))
      }
    } finally {
      if (planAbortRef.current === controller) {
        planAbortRef.current = null
        setPlanLoading(false)
        setPlanStage('')
        setPlanProgress(null)
      }
    }
  }

  async function executeImport() {
    if (!plan || importing || plan.records.length === 0) return
    setConfirmOpen(false)
    setImporting(true)
    setImportResult(null)
    setAuditWarning(null)
    importCancelRef.current = false
    let authAborted = false
    const chunks = chunkImportRecords(plan.records, 50, 700_000)
    const started = Date.now()
    let imported = 0
    let skipped = plan.counts.skip
    let bytes = 0
    const failed: { key: string; message: string }[] = plan.rows
      .filter((row) => row.action === 'error')
      .map((row) => ({ key: row.key, message: row.reason ?? '数据异常，未导入' }))

    setImportProgress({
      chunk: 0,
      totalChunks: chunks.length,
      imported: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
    })

    for (let index = 0; index < chunks.length; index += 1) {
      if (importCancelRef.current) break
      const chunk = chunks[index]
      try {
        const result = await adminApi.importRecords(adminToken, chunk, {
          skipExisting: strategy === 'skip',
          silent: true,
          guardLocal: strategy === 'merge',
          auditStart: chunks.length > 1 && index === 0,
          totalRecords: plan.records.length,
        })
        imported += result.imported.length
        skipped += result.skipped.length
        bytes += result.bytes
        failed.push(...result.failed)
      } catch (err) {
        if (handleAdminError(err)) {
          authAborted = true
          break
        }
        for (const record of chunk) {
          failed.push({ key: record.key, message: errorMessage(err) })
        }
      }
      setImportProgress({
        chunk: index + 1,
        totalChunks: chunks.length,
        imported,
        skipped,
        failed: failed.length,
        bytes,
      })
    }

    const cancelled = importCancelRef.current || authAborted
    if (!authAborted && (imported > 0 || skipped > 0 || failed.length > 0)) {
      try {
        await adminApi.importSummary(adminToken, {
          imported,
          skipped,
          failed: failed.length,
          bytes,
          cancelled,
        })
      } catch (err) {
        if (!handleAdminError(err)) {
          setAuditWarning('数据已处理，但汇总操作日志写入失败，请手动记录本次导入结果')
        }
      }
    }
    setImporting(false)
    setImportProgress(null)
    setImportResult({
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
      void loadLocalKeys()
      localCacheRef.current.clear()
      localLoadedRef.current.clear()
    } else if (!cancelled) {
      toast.error('导入失败', failed[0]?.message ?? '没有数据成功写入')
    }
  }

  const planRowsFiltered = useMemo(() => {
    if (!plan) return []
    if (planFilter === 'all') return plan.rows
    if (planFilter === 'change') {
      return plan.rows.filter(
        (row) => row.action === 'new' || row.action === 'overwrite' || row.action === 'merge',
      )
    }
    return plan.rows.filter((row) =>
      planFilter === 'skip' ? row.action === 'skip' : row.action === 'error',
    )
  }, [plan, planFilter])

  const planPageCount = Math.max(1, Math.ceil(planRowsFiltered.length / PLAN_PAGE_SIZE))
  const safePlanPage = Math.min(planPage, planPageCount - 1)
  const pagedPlanRows = planRowsFiltered.slice(
    safePlanPage * PLAN_PAGE_SIZE,
    safePlanPage * PLAN_PAGE_SIZE + PLAN_PAGE_SIZE,
  )

  const overwriteCount = plan?.counts.overwrite ?? 0
  const actionableCount = plan?.records.length ?? 0
  const step = !connection ? 1 : !plan && !planLoading ? 2 : 3
  const previewValue =
    previewRow?.value ??
    (previewRow ? remoteCache.current.get(previewRow.key) : undefined)

  return (
    <div className="import-panel">
      <div className="import-steps" aria-label="导入步骤">
        {[
          { index: 1, label: '连接云端' },
          { index: 2, label: '选择数据' },
          { index: 3, label: '预览并导入' },
        ].map((item) => (
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
        ))}
      </div>

      {!connection ? (
        <section className="v-card admin-card import-card">
          <div className="admin-card-head">
            <h2 className="text-subtitle-1 font-weight-medium">连接 Classworks 云端</h2>
            <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="primary">
              <MdiIcon name="shield-check" size={14} />
              只读导入
            </span>
          </div>
          <div className="admin-card-body">
            <div className="import-connect-grid">
              <label className="import-field">
                <span className="text-caption text-medium-emphasis">服务地址</span>
                <input
                  className="v-field mt-2 font-monospace"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={DEFAULT_UPSTREAM_SERVER}
                  spellCheck={false}
                  disabled={connecting}
                />
              </label>
              <label className="import-field">
                <span className="text-caption text-medium-emphasis">App Token</span>
                <div className="import-secret">
                  <input
                    className="v-field font-monospace"
                    type={showToken ? 'text' : 'password'}
                    value={tokenInput}
                    onChange={(event) => setTokenInput(event.target.value)}
                    placeholder="粘贴 Classworks 的 KV / App Token"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={connecting}
                  />
                  <button
                    type="button"
                    className="v-btn v-btn--icon v-btn--variant-text import-secret-toggle"
                    onClick={() => setShowToken((value) => !value)}
                    aria-label={showToken ? '隐藏 Token' : '显示 Token'}
                    title={showToken ? '隐藏 Token' : '显示 Token'}
                  >
                    <Icon name={showToken ? 'eyeOff' : 'eye'} size={18} />
                  </button>
                </div>
              </label>
            </div>

            <details
              className="import-advanced"
              open={advanced}
              onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}
            >
              <summary>高级：旧版 Site Key</summary>
              <label className="import-field mt-3">
                <span className="text-caption text-medium-emphasis">
                  旧版服务器可使用 x-site-key 认证；填写后将与 App Token 一并发送
                </span>
                <input
                  className="v-field mt-2 font-monospace"
                  type="password"
                  value={siteKeyInput}
                  onChange={(event) => setSiteKeyInput(event.target.value)}
                  placeholder="可选"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={connecting}
                />
              </label>
            </details>

            <div className="import-note">
              <MdiIcon name="information-outline" size={18} />
              <div>
                只读取上游云端数据，不会修改云端。Token 仅保存在当前页面内存中，不会写入浏览器存储。
                建议使用只读 Token；导入前会生成完整预览。
              </div>
            </div>

            {connectError && (
              <div className="v-alert v-alert--variant-tonal import-alert" data-color="error">
                <MdiIcon name="alert-circle-outline" size={20} />
                <div>{connectError}</div>
              </div>
            )}

            <div className="import-connect-actions">
              <button
                type="button"
                className="v-btn v-btn--variant-flat"
                data-color="primary"
                onClick={() => void connect()}
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <MdiIcon name="timer-sand" size={18} />
                    正在连接…
                  </>
                ) : (
                  <>
                    <MdiIcon name="link" size={18} />
                    连接并读取键列表
                  </>
                )}
              </button>
              <span className="text-caption text-medium-emphasis">
                默认地址：{DEFAULT_UPSTREAM_SERVER}
              </span>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="v-card admin-card import-connection-card">
            <div className="admin-card-head">
              <h2 className="text-subtitle-1 font-weight-medium">
                <MdiIcon name="cloud" size={18} className="mr-2" />
                {roleName(connection.info)}
              </h2>
              <div className="d-flex align-center" style={{ gap: 8 }}>
                {connection.info.token?.isReadOnly && (
                  <span
                    className="v-chip v-chip--size-small v-chip--variant-tonal"
                    data-color="warning"
                  >
                    云端只读
                  </span>
                )}
                <button
                  type="button"
                  className="v-btn v-btn--size-small v-btn--variant-outlined"
                  onClick={resetConnection}
                >
                  <MdiIcon name="refresh" size={16} />
                  重新连接
                </button>
              </div>
            </div>
            <div className="admin-card-body import-connection-body">
              <div className="import-connection-meta">
                <span>
                  <b>服务</b>
                  {connection.auth.baseUrl}
                </span>
                <span>
                  <b>命名空间</b>
                  {connection.info.device?.namespace || connection.info.device?.name || '—'}
                </span>
                <span>
                  <b>Token</b>
                  {TOKEN_TYPE_LABEL[connection.info.token?.deviceType ?? ''] ||
                    connection.info.token?.deviceType ||
                    '—'}
                  {connection.info.token?.note ? ` · ${connection.info.token.note}` : ''}
                </span>
                <span>
                  <b>云端键</b>
                  {remoteKeys.length}
                  {keyListInfo?.truncated ? '（已截断）' : ''}
                </span>
              </div>
              {connection.info.warnings.map((warning) => (
                <div className="import-inline-warning" key={warning}>
                  <MdiIcon name="alert-circle-outline" size={16} />
                  {warning}
                </div>
              ))}
              {keyListInfo?.truncated && (
                <div className="import-inline-warning">
                  <MdiIcon name="alert-circle-outline" size={16} />
                  云端键数量超过单次读取上限，仅展示前 {remoteKeys.length} 个。
                </div>
              )}
            </div>
          </section>

          <section className="v-card admin-card import-card">
            <div className="admin-card-head">
              <h2 className="text-subtitle-1 font-weight-medium">选择要导入的数据</h2>
              <span className="text-caption text-medium-emphasis">
                已选 {selected.size} 项 · 作业 {selectedBoardCount} · 配置 {selectedConfigCount}
                {selectedOtherCount ? ` · 其他 ${selectedOtherCount}` : ''}
              </span>
            </div>
            <div className="admin-card-body import-body">
              <div className="import-board-column">
                <div className="import-section-head">
                  <div>
                    <h3>作业数据</h3>
                    <p className="text-caption text-medium-emphasis">
                      云端共 {boards.length} 天{latestBoard ? ` · 最新 ${dateLabel(latestBoard.date)}` : ''}
                    </p>
                  </div>
                  <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                    已选 {selectedBoardCount}
                  </span>
                </div>

                <div className="import-board-toolbar">
                  <div className="admin-search import-board-search">
                    <MdiIcon name="magnify" size={18} />
                    <input
                      value={boardQuery}
                      onChange={(event) => setBoardQuery(event.target.value)}
                      placeholder="搜索日期"
                      aria-label="搜索日期"
                    />
                  </div>
                  <div className="import-range">
                    <input
                      className="v-field"
                      type="date"
                      value={fromDate}
                      aria-label="开始日期"
                      onChange={(event) => setFromDate(event.target.value)}
                    />
                    <span className="text-caption">至</span>
                    <input
                      className="v-field"
                      type="date"
                      value={toDate}
                      aria-label="结束日期"
                      onChange={(event) => setToDate(event.target.value)}
                    />
                  </div>
                </div>
                {fromDate && toDate && fromDate > toDate && (
                  <div className="text-caption text-error">开始日期晚于结束日期，请调整范围</div>
                )}
                {localKeysTruncated && (
                  <div className="import-inline-warning">
                    <MdiIcon name="alert-circle-outline" size={16} />
                    本地键超过单次列表上限，选择列表中的「本地已有」提示可能不完整；预览会逐键精确比对。
                  </div>
                )}

                <div className="import-quick-actions">
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    title="以云端最新作业日期为终点"
                    onClick={() => selectRecentBoards(7)}
                  >
                    最近 7 天
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    title="以云端最新作业日期为终点"
                    onClick={() => selectRecentBoards(30)}
                  >
                    最近 30 天
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => replaceBoardSelection(boards.map((item) => item.key))}
                  >
                    全部日期
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-text"
                    onClick={() => replaceBoardSelection([])}
                  >
                    清空日期
                  </button>
                </div>

                <div className="import-board-list">
                  {boards.length === 0 ? (
                    <div className="admin-empty">云端没有 classworks-data-* 作业数据</div>
                  ) : filteredBoards.length === 0 ? (
                    <div className="admin-empty">没有匹配的日期</div>
                  ) : (
                    <>
                      <label className="import-board-head">
                        <input
                          type="checkbox"
                          checked={allFilteredSelected}
                          onChange={() => {
                            if (allFilteredSelected) {
                              commitSelection((current) => {
                                for (const item of filteredBoards) current.delete(item.key)
                                return current
                              })
                            } else {
                              commitSelection((current) => {
                                for (const item of filteredBoards) current.add(item.key)
                                return current
                              })
                            }
                          }}
                        />
                        <span>日期</span>
                        <span>云端更新时间</span>
                        <span>状态</span>
                      </label>
                      {pagedBoards.map((item) => {
                        const checked = selected.has(item.key)
                        const conflict = localKeyMap.has(item.key)
                        return (
                          <label
                            key={item.key}
                            className={`import-board-row ${checked ? 'selected' : ''}`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleKey(item.key)}
                            />
                            <span className="import-board-date">
                              <b>{dateLabel(item.date)}</b>
                              <small>
                                {weekdayLabel(item.date)} · {item.key.replace('classworks-data-', '')}
                              </small>
                            </span>
                            <span className="import-muted">
                              {item.updatedAt ? relativeTime(item.updatedAt) : '—'}
                            </span>
                            <span>
                              {conflict ? (
                                <span
                                  className="v-chip v-chip--size-x-small v-chip--variant-tonal"
                                  data-color="warning"
                                >
                                  本地已有
                                </span>
                              ) : localKeysTruncated ? (
                                <span className="import-muted">状态待预览</span>
                              ) : (
                                <span className="import-muted">新数据</span>
                              )}
                            </span>
                          </label>
                        )
                      })}
                    </>
                  )}
                </div>

                <div className="import-pagination">
                  <span className="text-caption text-medium-emphasis">
                    共 {filteredBoards.length} 天 · 第 {safeBoardPage + 1} / {boardPageCount} 页
                  </span>
                  <div className="d-flex" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                      disabled={safeBoardPage === 0}
                      onClick={() => setBoardPage((value) => Math.max(0, value - 1))}
                      aria-label="上一页日期"
                    >
                      <MdiIcon name="chevron-left" size={18} />
                    </button>
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                      disabled={safeBoardPage >= boardPageCount - 1}
                      onClick={() =>
                        setBoardPage((value) => Math.min(boardPageCount - 1, value + 1))
                      }
                      aria-label="下一页日期"
                    >
                      <MdiIcon name="chevron-right" size={18} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="import-config-column">
                <div className="import-section-head">
                  <div>
                    <h3>配置数据</h3>
                    <p className="text-caption text-medium-emphasis">
                      花名册、科目、考试与模板
                    </p>
                  </div>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-text"
                    onClick={() => {
                      commitSelection((current) => {
                        const allSelected = configPresent.every((item) => current.has(item.key))
                        for (const item of configPresent) {
                          if (allSelected) current.delete(item.key)
                          else current.add(item.key)
                        }
                        return current
                      })
                    }}
                  >
                    {configPresent.length > 0 &&
                    configPresent.every((item) => selected.has(item.key))
                      ? '取消全选'
                      : '全选配置'}
                  </button>
                </div>

                <div className="import-config-list">
                  {configKeys.map((item) => {
                    const available = Boolean(item.remote)
                    const checked = selected.has(item.key)
                    const conflict = localKeyMap.has(item.key)
                    return (
                      <label
                        key={item.key}
                        className={`import-config-row ${checked ? 'selected' : ''} ${
                          available ? '' : 'disabled'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!available}
                          onChange={() => toggleKey(item.key)}
                        />
                        <span className="import-config-icon">
                          <MdiIcon name={CATEGORY_ICON[item.category]} size={20} />
                        </span>
                        <span className="import-config-text">
                          <b>{item.label}</b>
                          <small>{item.description}</small>
                          <small className="import-muted">
                            {available
                              ? `云端更新：${
                                  item.remote?.updatedAt
                                    ? relativeTime(item.remote.updatedAt)
                                    : '时间未知'
                                }`
                              : '云端无此数据'}
                          </small>
                        </span>
                        <span>
                          {conflict && available ? (
                            <span
                              className="v-chip v-chip--size-x-small v-chip--variant-tonal"
                              data-color="warning"
                            >
                              本地已有
                            </span>
                          ) : localKeysTruncated && available ? (
                            <span className="import-muted">状态待预览</span>
                          ) : null}
                        </span>
                      </label>
                    )
                  })}
                </div>

                {otherKeys.length > 0 && (
                  <div className="import-other">
                    <button
                      type="button"
                      className="import-other-toggle"
                      onClick={() => setShowOthers((value) => !value)}
                      aria-expanded={showOthers}
                    >
                      <MdiIcon name={showOthers ? 'chevron-down' : 'chevron-right'} size={18} />
                      其他数据 ({otherKeys.length})
                      <span className="text-caption text-medium-emphasis">
                        通知、噪音报告等，按原样导入
                      </span>
                    </button>
                    {showOthers && (
                      <div className="import-other-list">
                        {otherKeys.map((item) => (
                          <label className="import-other-row" key={item.key}>
                            <input
                              type="checkbox"
                              checked={selected.has(item.key)}
                              onChange={() => toggleKey(item.key)}
                            />
                            <span className="import-other-key">{item.key}</span>
                            <span className="import-muted">
                              {item.updatedAt ? relativeTime(item.updatedAt) : '—'}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className="v-card admin-card import-card">
            <div className="admin-card-head">
              <h2 className="text-subtitle-1 font-weight-medium">冲突处理与预览</h2>
              <span className="text-caption text-medium-emphasis">
                合并策略优先保留本地内容
              </span>
            </div>
            <div className="admin-card-body">
              <div className="import-strategy-grid">
                <StrategyCard
                  active={strategy === 'merge'}
                  title="合并（推荐）"
                  description="作业按科目补齐，花名册/科目/考试去重合并；其他本地已有数据保留。"
                  onClick={() => {
                    setStrategy('merge')
                    invalidatePlan()
                  }}
                />
                <StrategyCard
                  active={strategy === 'overwrite'}
                  title="覆盖"
                  description="同名键直接使用云端数据替换本地，适合从上游完整迁移。"
                  onClick={() => {
                    setStrategy('overwrite')
                    invalidatePlan()
                  }}
                />
                <StrategyCard
                  active={strategy === 'skip'}
                  title="跳过已有"
                  description="本地已有同名键时保留本地，只写入云端新增的键。"
                  onClick={() => {
                    setStrategy('skip')
                    invalidatePlan()
                  }}
                />
              </div>

              <label className="import-check-line">
                <input
                  type="checkbox"
                  checked={skipEmptyBoards}
                  onChange={(event) => {
                    setSkipEmptyBoards(event.target.checked)
                    invalidatePlan()
                  }}
                />
                跳过空白作业板（无作业且无出勤）
              </label>

              <div className="import-note">
                <MdiIcon name="information-outline" size={18} />
                <div>
                  预览阶段会读取所选数据并逐键比对本地状态。大量数据会分批读取与写入，可在进度中查看或取消。
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
                      <div className="text-body-2">{planStage || '正在生成预览…'}</div>
                      {planProgress && (
                        <div className="text-caption text-medium-emphasis">
                          {planProgress.done} / {planProgress.total}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-text"
                      onClick={cancelPlan}
                    >
                      取消
                    </button>
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
                <div ref={planSectionRef} className="import-plan">
                  <div className="import-plan-summary">
                    {[
                      ['新增', plan.counts.new, 'success'],
                      ['覆盖', plan.counts.overwrite, 'warning'],
                      ['合并', plan.counts.merge, 'primary'],
                      ['跳过', plan.counts.skip, 'grey'],
                      ['错误', plan.counts.error, 'error'],
                    ].map(([label, count, color]) => (
                      <div className="import-stat" key={String(label)}>
                        <span className={`import-stat-value text-${color}`}>{String(count)}</span>
                        <span className="import-stat-label">{String(label)}</span>
                      </div>
                    ))}
                    <div className="import-stat import-stat--wide">
                      <span className="import-stat-value">{formatBytes(plan.totalBytes)}</span>
                      <span className="import-stat-label">预计写入</span>
                    </div>
                  </div>

                  {plan.warningCount > 0 && (
                    <div className="v-alert v-alert--variant-tonal import-alert" data-color="warning">
                      <MdiIcon name="alert-circle-outline" size={20} />
                      <div>
                        预览中有 {plan.warningCount} 条提示（结构修正、空白作业板或超大记录），
                        请在导入前查看。
                      </div>
                    </div>
                  )}

                  <div className="import-plan-toolbar">
                    <div className="import-plan-filters">
                      {(
                        [
                          ['all', `全部 ${plan.rows.length}`],
                          ['change', `将变更 ${plan.counts.new + plan.counts.overwrite + plan.counts.merge}`],
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
                      {!importResult && (
                        <button
                          type="button"
                          className="v-btn v-btn--size-small v-btn--variant-flat"
                          data-color={overwriteCount > 0 ? 'warning' : 'primary'}
                          disabled={actionableCount === 0 || importing}
                          onClick={() => setConfirmOpen(true)}
                        >
                          <MdiIcon name="file-import-outline" size={16} />
                          开始导入 {actionableCount} 条
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="import-plan-table">
                    <div className="import-plan-head">
                      <span>数据</span>
                      <span>处理</span>
                      <span>本地</span>
                      <span>摘要</span>
                      <span>大小</span>
                    </div>
                    {pagedPlanRows.map((row) => (
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
                        <span className="import-plan-summary-cell">
                          {row.summary}
                          {row.warnings.length > 0 && (
                            <small className="text-warning">
                              {row.warnings.join('；')}
                            </small>
                          )}
                        </span>
                        <span className="import-muted">
                          {row.size ? formatBytes(row.size) : '—'}
                        </span>
                      </button>
                    ))}
                    {pagedPlanRows.length === 0 && (
                      <div className="admin-empty">该筛选下没有记录</div>
                    )}
                  </div>

                  <div className="import-pagination">
                    <span className="text-caption text-medium-emphasis">
                      共 {planRowsFiltered.length} 条 · 第 {safePlanPage + 1} / {planPageCount} 页
                    </span>
                    <div className="d-flex" style={{ gap: 6 }}>
                      <button
                        type="button"
                        className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                        disabled={safePlanPage === 0}
                        onClick={() => setPlanPage((value) => Math.max(0, value - 1))}
                        aria-label="上一页预览"
                      >
                        <MdiIcon name="chevron-left" size={18} />
                      </button>
                      <button
                        type="button"
                        className="v-btn v-btn--icon v-btn--size-small v-btn--variant-text"
                        disabled={safePlanPage >= planPageCount - 1}
                        onClick={() =>
                          setPlanPage((value) => Math.min(planPageCount - 1, value + 1))
                        }
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
                      已选择 {selected.size} 项数据，云端 {remoteKeys.length} 个键
                    </div>
                    <div className="text-caption text-medium-emphasis">
                      预览会校验结构、识别冲突并计算最终写入内容，不会修改任何数据。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="v-btn v-btn--variant-flat"
                    data-color="primary"
                    disabled={selected.size === 0}
                    onClick={() => void generatePlan()}
                  >
                    <MdiIcon name="eye" size={18} />
                    生成导入预览
                  </button>
                </div>
              )}

              {importing && importProgress && (
                <div className="import-progress-card import-progress-card--active">
                  <div className="d-flex align-center" style={{ gap: 10 }}>
                    <MdiIcon name="timer-sand" size={20} className="text-primary" />
                    <div className="flex-grow-1">
                      <div className="text-body-2">
                        {importProgress.chunk === 0
                          ? `正在准备导入 ${importProgress.totalChunks} 批数据…`
                          : `正在导入第 ${importProgress.chunk} / ${importProgress.totalChunks} 批`}
                      </div>
                      <div className="text-caption text-medium-emphasis">
                        已写入 {importProgress.imported} 条
                        {importProgress.skipped ? ` · 跳过 ${importProgress.skipped} 条` : ''}
                        {importProgress.failed ? ` · 失败 ${importProgress.failed} 条` : ''}
                        {' · '}
                        {formatBytes(importProgress.bytes)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-text"
                      onClick={() => {
                        importCancelRef.current = true
                      }}
                    >
                      取消
                    </button>
                  </div>
                  <div
                    className="v-progress-linear"
                    style={{ height: 6, borderRadius: 3, marginTop: 10 }}
                  >
                    <div
                      className="v-progress-linear__bar"
                      style={{
                        width: `${
                          importProgress.totalChunks
                            ? (importProgress.chunk / importProgress.totalChunks) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              )}

              {importResult && (
                <div className="import-result">
                  <div className="import-result-head">
                    <span className="import-result-icon">
                      <MdiIcon
                        name={
                          importResult.failed.length
                            ? 'alert-circle-outline'
                            : importResult.cancelled
                              ? 'information-outline'
                              : 'check-circle'
                        }
                        size={24}
                      />
                    </span>
                    <div>
                      <div className="text-subtitle-1 font-weight-medium">
                        {importResult.cancelled
                          ? '导入已取消'
                          : importResult.failed.length
                            ? '导入完成（部分失败）'
                            : '导入完成'}
                      </div>
                      <div className="text-caption text-medium-emphasis">
                        写入 {importResult.imported} 条
                        {importResult.skipped ? ` · 跳过 ${importResult.skipped} 条` : ''}
                        {importResult.failed.length
                          ? ` · 失败 ${importResult.failed.length} 条`
                          : ''}
                        {' · '}
                        {formatBytes(importResult.bytes)} ·{' '}
                        {(importResult.durationMs / 1000).toFixed(1)} 秒
                      </div>
                    </div>
                    <div className="flex-grow-1" />
                    <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                      <button
                        type="button"
                        className="v-btn v-btn--size-small v-btn--variant-outlined"
                        onClick={() => {
                          setImportResult(null)
                          setPlan(null)
                          localCacheRef.current.clear()
                          localLoadedRef.current.clear()
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
                  {importResult.failed.length > 0 && (
                    <div className="import-result-failures">
                      {importResult.failed.slice(0, 100).map((failure) => (
                        <div key={failure.key}>
                          <span className="font-monospace">{failure.key}</span>
                          <span>{failure.message}</span>
                        </div>
                      ))}
                      {importResult.failed.length > 100 && (
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
        </>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="确认导入"
        text={
          <>
            将从 Classworks 云端写入 <b>{actionableCount}</b> 条数据到本地
            {plan && (
              <>
                （新增 {plan.counts.new}、覆盖 {plan.counts.overwrite}、合并 {plan.counts.merge}）
              </>
            )}
            。
            {overwriteCount > 0 && (
              <span className="text-warning">
                {' '}
                其中 {overwriteCount} 条会覆盖本地同键数据，操作无法撤销。
              </span>
            )}
          </>
        }
        confirmText={importing ? '导入中…' : '开始导入'}
        danger={overwriteCount > 0}
        onCancel={() => {
          if (!importing) setConfirmOpen(false)
        }}
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
            {previewRow.reason && (
              <div className="v-alert v-alert--variant-tonal import-alert" data-color="info">
                <MdiIcon name="information-outline" size={20} />
                <div>{previewRow.reason}</div>
              </div>
            )}
            {previewRow.warnings.length > 0 && (
              <div className="v-alert v-alert--variant-tonal import-alert" data-color="warning">
                <MdiIcon name="alert-circle-outline" size={20} />
                <div>{previewRow.warnings.join('；')}</div>
              </div>
            )}
            <ValuePreview
              category={previewRow.category}
              value={previewValue}
              summary={previewRow.summary}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 预览渲染                                                            */
/* ------------------------------------------------------------------ */

function ValuePreview({
  category,
  value,
  summary,
}: {
  category: ImportCategory
  value: unknown
  summary: string
}) {
  if (value === undefined || value === null) {
    return (
      <div className="admin-empty">
        {summary}
        <div className="text-caption text-medium-emphasis mt-1">没有可预览的写入内容</div>
      </div>
    )
  }

  if (category === 'board') {
    const board = normalizeBoardValue(value)
    if (!board) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return <BoardPreview board={board.value} />
  }
  if (category === 'students') {
    const students = normalizeStudents(value)
    if (!students) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return (
      <div className="import-preview-section">
        <div className="import-preview-title">花名册 · {students.length} 人</div>
        <div className="import-preview-chips">
          {students.map((student) => (
            <span className="v-chip v-chip--size-small v-chip--variant-tonal" key={student.name}>
              {student.name}
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (category === 'subjects') {
    const subjects = normalizeSubjects(value)
    if (!subjects) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return (
      <div className="import-preview-section">
        <div className="import-preview-title">科目 · {subjects.length} 个</div>
        <div className="import-preview-chips">
          {subjects.map((subject) => (
            <span
              className="v-chip v-chip--size-small v-chip--variant-tonal"
              data-color="primary"
              key={subject.name}
            >
              {subject.order + 1}. {subject.name}
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (category === 'exams') {
    const exams = normalizeExams(value)
    if (!exams) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return <ExamPreview exams={exams} />
  }
  if (category === 'noise') {
    const noise = normalizeNoiseConfig(value)
    if (!noise) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return (
      <div className="import-preview-section">
        <div className="import-preview-title">
          噪音时段 · 阈值 {noise.alertThresholdDb} dB
        </div>
        <div className="import-preview-list">
          {noise.sessions.map((session) => (
            <div key={`${session.name}-${session.start}`}>
              <b>{session.name}</b>
              <span>
                {session.start} · {session.duration} 分钟 · {session.enabled ? '启用' : '停用'}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (category === 'template') {
    const template = normalizeTemplate(value)
    if (!template) return <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    return (
      <div className="import-preview-section">
        <div className="import-preview-title">
          作业模板 · {Object.keys(template.subjects ?? {}).length} 个科目
        </div>
        <pre className="import-json">{JSON.stringify(template, null, 2)}</pre>
      </div>
    )
  }
  return (
    <div className="import-preview-section">
      <div className="import-preview-title">{summary}</div>
      <pre className="import-json">{JSON.stringify(value, null, 2)}</pre>
    </div>
  )
}

function BoardPreview({ board }: { board: BoardData }) {
  const entries = Object.entries(board.homework)
  return (
    <div className="import-preview-board">
      <div className="import-preview-meta">
        <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="primary">
          {entries.length} 个科目
        </span>
        <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="error">
          请假 {board.attendance.absent.length}
        </span>
        <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="warning">
          迟到 {board.attendance.late.length}
        </span>
        <span className="v-chip v-chip--size-small v-chip--variant-tonal">
          不参与 {board.attendance.exclude.length}
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="admin-empty">空白作业板</div>
      ) : (
        <div className="import-preview-board-list">
          {entries.map(([subject, item]) => (
            <div className="import-preview-subject" key={subject}>
              <div className="import-preview-subject-head">
                <span>{subject}</span>
                {item.type === 'custom' && <small>自定义卡片</small>}
                {item.type === 'exam' && <small>考试卡片</small>}
              </div>
              <div className="import-preview-content">
                {item.content
                  ? item.content.split('\n').filter(Boolean).map((line, index) => (
                      <div key={`${index}-${line}`}>{line}</div>
                    ))
                  : '（空内容）'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ExamPreview({ exams }: { exams: ExamConfig[] }) {
  return (
    <div className="import-preview-section">
      <div className="import-preview-title">考试 · {exams.length} 场</div>
      <div className="import-preview-board-list">
        {exams.map((exam) => (
          <div className="import-preview-subject" key={exam.id}>
            <div className="import-preview-subject-head">
              <span>{exam.examName}</span>
              <small>{exam.id}</small>
            </div>
            <div className="import-preview-content">
              {exam.subjects.map((subject, index) => (
                <div key={`${subject.name}-${index}`}>
                  {subject.date} {subject.start ?? ''}
                  {subject.end ? `-${subject.end}` : ''} · {subject.name}
                  {subject.room ? ` · ${subject.room}` : ''}
                </div>
              ))}
              {exam.subjects.length === 0 && '（暂无科目安排）'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

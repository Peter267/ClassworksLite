import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AppBar } from '../components/AppBar'
import { MdiIcon } from '../components/MdiIcon'
import { UpstreamImportPanel } from '../components/admin/UpstreamImportPanel'
import { ConfirmDialog, Modal } from '../components/ui/Modal'
import {
  AdminError,
  adminApi,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
  type AdminKeyInfo,
  type AdminStats,
} from '../lib/admin'
import { relativeTime } from '../lib/date'
import { toast } from '../lib/toast'

type Tab = 'overview' | 'data' | 'import' | 'logs'
type Phase = 'checking' | 'login' | 'ready'
type ActorFilter = 'all' | 'admin' | 'site'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'overview', label: '概览', icon: 'monitor' },
  { key: 'data', label: '数据', icon: 'database' },
  { key: 'import', label: '云端导入', icon: 'file-import-outline' },
  { key: 'logs', label: '日志', icon: 'history' },
]

const TAB_HEADINGS: Record<Tab, { title: string; subtitle: string }> = {
  overview: { title: '站点总览', subtitle: '全站数据、操作日志与备份' },
  data: { title: '数据管理', subtitle: '浏览、编辑、新建与删除全站数据键' },
  import: { title: '云端导入', subtitle: '从上游 Classworks 云端批量迁移作业与配置' },
  logs: { title: '操作日志', subtitle: '管理员与站点的写入、删除和登录记录' },
}

const GROUPS = [
  { id: 'all', label: '全部' },
  { id: 'boards', label: '作业数据' },
  { id: 'roster', label: '花名册' },
  { id: 'subjects', label: '科目' },
  { id: 'exams', label: '考试' },
  { id: 'template', label: '作业模板' },
  { id: 'noise', label: '噪音时段' },
  { id: 'other', label: '其他' },
] as const

type GroupId = (typeof GROUPS)[number]['id']

const GROUP_LABELS: Record<string, string> = Object.fromEntries(
  GROUPS.map((item) => [item.id, item.label]),
)

const ACTION_LABELS: Record<string, string> = {
  login: '登录',
  login_failed: '登录失败',
  write: '写入',
  delete: '删除',
  import: '导入',
  clear_logs: '清空日志',
  denied: '拒绝访问',
}

const PAGE_SIZE = 30

interface EditorState {
  mode: 'create' | 'edit'
  key: string
  valueText: string
  baseUpdatedAt?: number
  size?: number
  group?: string
  legacy?: boolean
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function formatTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function errorMessage(err: unknown): string {
  if (err instanceof AdminError) {
    if (err.code === 'admin_not_configured') {
      return '管理后台未启用，请联系管理员'
    }
    return err.message
  }
  return err instanceof Error ? err.message : '未知错误'
}

function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: string
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="admin-stat">
      <span className="admin-stat-icon">
        <MdiIcon name={icon} size={22} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="admin-stat-value">{value}</div>
        <div className="admin-stat-label">{label}</div>
        <div className="admin-stat-hint">{hint}</div>
      </div>
    </div>
  )
}

export function AdminPage({ onBack }: { onBack: () => void }) {
  const [token, setToken] = useState<string | null>(() => getAdminToken())
  const [phase, setPhase] = useState<Phase>(() => (getAdminToken() ? 'checking' : 'login'))
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')
  const [importVisited, setImportVisited] = useState(false)

  const [stats, setStats] = useState<AdminStats | null>(null)
  const [keys, setKeys] = useState<AdminKeyInfo[] | null>(null)
  const [keysTotal, setKeysTotal] = useState(0)
  const [keysHasMore, setKeysHasMore] = useState(false)
  const [keysNextOffset, setKeysNextOffset] = useState(0)
  const [keysLoadingMore, setKeysLoadingMore] = useState(false)
  const [logs, setLogs] = useState<Awaited<ReturnType<typeof adminApi.logs>>['logs'] | null>(null)
  const [logLimit, setLogLimit] = useState(500)

  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupId>('all')
  const [page, setPage] = useState(0)
  const [logActor, setLogActor] = useState<ActorFilter>('all')
  const [logQuery, setLogQuery] = useState('')

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminKeyInfo | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportCancelRef = useRef(false)
  const [exportProgress, setExportProgress] = useState<{
    open: boolean
    status: 'running' | 'done' | 'error' | 'cancelled'
    loaded: number
    total: number
    bytes: number
    message?: string
  } | null>(null)

  const handleAuthError = useCallback((err: unknown): boolean => {
    if (err instanceof AdminError && err.status === 401) {
      clearAdminToken()
      setToken(null)
      setPhase('login')
      setLoginError('管理会话已过期，请重新登录')
      setStats(null)
      setKeys(null)
      setKeysTotal(0)
      setKeysHasMore(false)
      setKeysNextOffset(0)
      setLogs(null)
      return true
    }
    return false
  }, [])

  const loadOverview = useCallback(
    async (withBusy = true) => {
      if (!token) return
      if (withBusy) setBusy(true)
      try {
        let overview: Awaited<ReturnType<typeof adminApi.overview>>
        try {
          overview = await adminApi.overview(token)
        } catch (err) {
          // 兼容尚未部署 overview 动作的旧后端
          if (err instanceof AdminError && err.status === 400) {
            const [stats, keys] = await Promise.all([
              adminApi.stats(token),
              adminApi.keys(token),
            ])
            overview = { stats, keys: keys.keys, truncated: keys.truncated }
          } else {
            throw err
          }
        }
        const logsResult = await adminApi.logs(token)
        setStats(overview.stats)
        setLogs(logsResult.logs)
        setLogLimit(logsResult.limit)
      } catch (err) {
        if (!handleAuthError(err)) toast.error('加载概览失败', errorMessage(err))
      } finally {
        if (withBusy) setBusy(false)
      }
    },
    [token, handleAuthError],
  )

  const loadKeys = useCallback(
    async (withBusy = true) => {
      if (!token) return
      if (withBusy) setBusy(true)
      try {
        const result = await adminApi.keysPage(token, 0, 500)
        setKeys(result.keys)
        setKeysTotal(result.total)
        setKeysHasMore(result.hasMore)
        setKeysNextOffset(result.nextOffset)
      } catch (err) {
        if (!handleAuthError(err)) toast.error('加载数据失败', errorMessage(err))
      } finally {
        if (withBusy) setBusy(false)
      }
    },
    [token, handleAuthError],
  )

  const loadMoreKeys = useCallback(
    async (all = false) => {
      if (!token || keysLoadingMore) return
      setKeysLoadingMore(true)
      let nextOffset = keysNextOffset
      let hasMore = keysHasMore
      let accumulated = keys ?? []
      try {
        for (;;) {
          const result = await adminApi.keysPage(token, nextOffset, 500)
          const merged = new Map(accumulated.map((item) => [item.key, item]))
          for (const item of result.keys) merged.set(item.key, item)
          accumulated = [...merged.values()]
          nextOffset = result.nextOffset
          hasMore = result.hasMore
          setKeys(accumulated)
          setKeysTotal(result.total)
          setKeysNextOffset(nextOffset)
          setKeysHasMore(hasMore)
          if (!all || !hasMore) break
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      } catch (err) {
        if (!handleAuthError(err)) toast.error('加载更多数据失败', errorMessage(err))
      } finally {
        setKeysLoadingMore(false)
      }
    },
    [token, keys, keysHasMore, keysNextOffset, keysLoadingMore, handleAuthError],
  )

  const loadLogs = useCallback(
    async (withBusy = true) => {
      if (!token) return
      if (withBusy) setBusy(true)
      try {
        const result = await adminApi.logs(token)
        setLogs(result.logs)
        setLogLimit(result.limit)
      } catch (err) {
        if (!handleAuthError(err)) toast.error('加载日志失败', errorMessage(err))
      } finally {
        if (withBusy) setBusy(false)
      }
    },
    [token, handleAuthError],
  )

  useEffect(() => {
    if (phase !== 'checking' || !token) return
    let alive = true
    adminApi
      .session(token)
      .then(() => {
        if (alive) setPhase('ready')
      })
      .catch((err: unknown) => {
        if (!alive) return
        if (err instanceof AdminError && err.status === 401) {
          clearAdminToken()
          setToken(null)
          setLoginError('管理会话已过期，请重新登录')
        } else {
          setLoginError(errorMessage(err))
        }
        setPhase('login')
      })
    return () => {
      alive = false
    }
  }, [phase, token])

  useEffect(() => {
    if (phase !== 'ready' || !token) return
    void loadOverview()
  }, [phase, token, loadOverview])

  useEffect(() => {
    if (phase !== 'ready' || !token) return
    if (tab === 'data' && keys === null) void loadKeys()
    if (tab === 'logs' && logs === null) void loadLogs()
  }, [phase, token, tab, keys, logs, loadKeys, loadLogs])

  function openImport() {
    selectTab('import')
  }

  useEffect(() => {
    setPage(0)
  }, [query, group])

  useEffect(() => {
    if (tab === 'import') setImportVisited(true)
  }, [tab])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setLoginError(null)
    try {
      const result = await adminApi.login(password)
      setAdminToken(result.token)
      setToken(result.token)
      setPassword('')
      setPhase('ready')
    } catch (err) {
      setLoginError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function logout() {
    clearAdminToken()
    setToken(null)
    setPhase('login')
    setPassword('')
    setLoginError(null)
    setStats(null)
    setKeys(null)
    setKeysTotal(0)
    setKeysHasMore(false)
    setKeysNextOffset(0)
    setLogs(null)
    setTab('overview')
  }

  function refreshCurrent() {
    if (tab === 'overview') void loadOverview()
    else if (tab === 'data') void loadKeys()
    else void loadLogs()
  }

  /** 切换分区时回到顶部：概览与数据的文档高度差异很大，沿用上一屏的滚动位置会突然跳一下 */
  function selectTab(next: Tab) {
    if (next === tab) return
    setTab(next)
    const root = document.documentElement
    const previous = root.style.scrollBehavior
    root.style.scrollBehavior = 'auto'
    window.scrollTo(0, 0)
    root.style.scrollBehavior = previous
  }

  async function openEditor(row: AdminKeyInfo) {
    if (!token) return
    setOpeningKey(row.key)
    try {
      const record = await adminApi.get(token, row.key)
      setEditor({
        mode: 'edit',
        key: record.key,
        valueText: JSON.stringify(record.value, null, 2) ?? 'null',
        baseUpdatedAt: record.updatedAt,
        size: record.size,
        group: record.group,
        legacy: record.legacy,
      })
      setEditorError(null)
    } catch (err) {
      if (!handleAuthError(err)) toast.error('读取数据失败', errorMessage(err))
    } finally {
      setOpeningKey(null)
    }
  }

  function openCreate() {
    setEditor({ mode: 'create', key: '', valueText: '{\n  \n}' })
    setEditorError(null)
  }

  function closeEditor() {
    if (saving) return
    setEditor(null)
    setEditorError(null)
  }

  const jsonError = useMemo(() => {
    if (!editor) return null
    if (!editor.valueText.trim()) return null
    try {
      JSON.parse(editor.valueText)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : 'JSON 格式错误'
    }
  }, [editor])

  async function saveEditor() {
    if (!editor || !token || saving) return
    const key = editor.key.trim()
    if (!key) {
      setEditorError('请填写数据键')
      return
    }
    let value: unknown
    try {
      value = JSON.parse(editor.valueText)
    } catch (err) {
      setEditorError(`JSON 格式错误：${err instanceof Error ? err.message : '无法解析'}`)
      return
    }

    setSaving(true)
    setEditorError(null)
    try {
      await adminApi.save(
        token,
        key,
        value,
        editor.mode === 'edit' ? editor.baseUpdatedAt : undefined,
      )
      toast.success(editor.mode === 'edit' ? '已保存修改' : '已创建数据键', key)
      setEditor(null)
      await Promise.all([loadKeys(false), loadOverview(false)])
    } catch (err) {
      if (!handleAuthError(err)) setEditorError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || !token || deleting) return
    setDeleting(true)
    const key = deleteTarget.key
    try {
      await adminApi.remove(token, key, deleteTarget.updatedAt)
      toast.success('已删除', key)
      setDeleteTarget(null)
      setEditor((current) => (current?.key === key ? null : current))
      await Promise.all([loadKeys(false), loadOverview(false)])
    } catch (err) {
      if (!handleAuthError(err)) toast.error('删除失败', errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  async function confirmClearLogs() {
    if (!token || clearing) return
    setClearing(true)
    try {
      await adminApi.clearLogs(token)
      toast.success('日志已清空', '后续操作会重新开始记录')
      setClearOpen(false)
      await Promise.all([loadLogs(false), loadOverview(false)])
    } catch (err) {
      if (!handleAuthError(err)) toast.error('清空失败', errorMessage(err))
    } finally {
      setClearing(false)
    }
  }

  async function exportBackup() {
    if (!token || exporting) return
    setExporting(true)
    exportCancelRef.current = false
    setExportProgress({ open: true, status: 'running', loaded: 0, total: 0, bytes: 0 })
    const exportedAt = Date.now()
    try {
      const parts: string[] = []
      let offset = 0
      let loaded = 0
      let total = 0
      let bytes = 0

      const maxFileBytes = 200 * 1024 * 1024
      for (;;) {
        if (exportCancelRef.current) {
          setExportProgress((current) =>
            current
              ? { ...current, status: 'cancelled', message: '已取消导出，未生成文件' }
              : current,
          )
          toast.info('已取消导出', '未生成备份文件')
          return
        }
        const page = await adminApi.backupPage(token, offset, 200)
        total = page.total
        for (const record of page.records) {
          parts.push(
            `${JSON.stringify(record.key)}:{"value":${JSON.stringify(
              record.value,
            )},"updatedAt":${record.updatedAt}}`,
          )
        }
        loaded += page.records.length
        bytes += page.bytes
        if (bytes > maxFileBytes) {
          throw new Error('导出数据超过 200 MB，请分批治理或使用服务器侧备份')
        }
        setExportProgress((current) =>
          current ? { ...current, loaded, total, bytes } : current,
        )
        if (!page.hasMore) break
        offset = page.nextOffset
        // 让出主线程，保持进度条与取消按钮可响应
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const header = `{"exportedAt":${exportedAt},"count":${loaded},"bytes":${bytes},"data":{`
      const blob = new Blob([header, parts.join(','), '}}'], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `classworks-lite-backup-${new Date(exportedAt)
        .toISOString()
        .slice(0, 10)}.json`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setExportProgress((current) =>
        current ? { ...current, status: 'done', loaded, total, bytes } : current,
      )
      toast.success('备份已导出', `${loaded} 条数据 · ${formatBytes(bytes)}`)
    } catch (err) {
      if (handleAuthError(err)) {
        setExportProgress(null)
        return
      }
      const message = errorMessage(err)
      setExportProgress((current) => (current ? { ...current, status: 'error', message } : current))
      toast.error('导出失败', message)
    } finally {
      setExporting(false)
    }
  }

  const filteredKeys = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return (keys ?? [])
      .filter((item) => group === 'all' || item.group === group)
      .filter((item) => !keyword || item.key.toLowerCase().includes(keyword))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [keys, query, group])

  const pageCount = Math.max(1, Math.ceil(filteredKeys.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedKeys = filteredKeys.slice(
    currentPage * PAGE_SIZE,
    currentPage * PAGE_SIZE + PAGE_SIZE,
  )

  const filteredLogs = useMemo(() => {
    const keyword = logQuery.trim().toLowerCase()
    return (logs ?? []).filter((entry) => {
      if (logActor !== 'all' && entry.actor !== logActor) return false
      if (!keyword) return true
      return [entry.action, entry.key, entry.ip, entry.note, entry.ua].some((value) =>
        value ? value.toLowerCase().includes(keyword) : false,
      )
    })
  }, [logs, logActor, logQuery])

  const recentLogs = (logs ?? []).slice(0, 6)
  const maxGroupBytes = Math.max(1, ...(stats?.groups.map((item) => item.bytes) ?? [0]))
  const heading = TAB_HEADINGS[tab]
  const dataKeyCount = tab === 'data' && keysTotal > 0 ? keysTotal : stats?.totalKeys

  if (phase !== 'ready') {
    return (
      <>
        <AppBar
          title="管理后台"
          back={{ label: '返回', onBack }}
          hideSettings
          hideBell
          elevation={1}
        />
        <div className="admin-login-wrap">
          {phase === 'checking' ? (
            <div className="d-flex flex-column align-center" style={{ gap: 12 }}>
              <div className="loading-spinner" />
              <span className="text-caption text-medium-emphasis">正在验证管理会话…</span>
            </div>
          ) : (
            <form className="admin-login-card" onSubmit={handleLogin}>
              <span className="admin-login-icon">
                <MdiIcon name="shield-key" size={30} />
              </span>
              <h1 className="text-h5">管理后台</h1>
              <p className="text-body-2 text-medium-emphasis mt-2">
                输入管理密码即可管理全站数据与操作日志。
              </p>

              <label className="block mt-6">
                <span className="text-caption text-medium-emphasis">管理密码</span>
                <input
                  className="v-field mt-2"
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  placeholder="输入管理密码"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={busy}
                />
              </label>

              {loginError && (
                <div className="admin-login-error" role="alert">
                  {loginError}
                </div>
              )}

              <button
                type="submit"
                className="v-btn v-btn--variant-flat v-btn--size-large w-full mt-5"
                data-color="primary"
                disabled={busy || password.length === 0}
              >
                {busy ? '验证中…' : '登录'}
              </button>

              <div className="admin-login-foot">
                连续 5 次密码错误会锁定当前 IP 10 分钟；关闭标签页即退出登录。
              </div>
            </form>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <AppBar
        title="管理后台"
        back={{ label: '返回', onBack }}
        hideSettings
        hideBell
        elevation={1}
        actions={
          <>
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text"
              onClick={refreshCurrent}
              disabled={busy}
              title="刷新"
              aria-label="刷新"
            >
              <MdiIcon name="refresh" size={22} />
            </button>
            <button
              type="button"
              className="v-btn v-btn--icon v-btn--variant-text"
              onClick={logout}
              title="退出登录"
              aria-label="退出登录"
            >
              <MdiIcon name="lock-clock" size={22} />
            </button>
          </>
        }
      />

      <div className="admin-page">
        <div className="admin-shell">
          <header className="admin-heading">
            <div>
              <h1 className="text-h5">{heading.title}</h1>
              <p className="text-body-2 text-medium-emphasis mt-1">
                {heading.subtitle} ·{' '}
                {dataKeyCount !== undefined ? `${dataKeyCount} 个数据键` : '正在加载…'}
              </p>
            </div>
            <div className="d-flex flex-wrap align-center" style={{ gap: 8 }}>
              <span className="v-chip v-chip--size-small v-chip--variant-tonal" data-color="success">
                <MdiIcon name="shield-check" size={14} />
                已登录
              </span>
            </div>
          </header>

          <nav className="admin-tabs" aria-label="管理后台分区">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`admin-tab ${tab === item.key ? 'active' : ''}`}
                aria-current={tab === item.key ? 'page' : undefined}
                onClick={() => selectTab(item.key)}
              >
                <MdiIcon name={item.icon} size={18} />
                {item.label}
              </button>
            ))}
          </nav>

          {tab === 'overview' && (
            <>
              <div className="admin-stat-grid">
                <StatCard
                  icon="database"
                  label="数据键"
                  value={stats ? String(stats.totalKeys) : '—'}
                  hint={stats?.truncated ? '仅统计前 1000 条' : '不含日志等内部键'}
                />
                <StatCard
                  icon="counter"
                  label="占用空间"
                  value={stats ? formatBytes(stats.totalBytes) : '—'}
                  hint="原始数据大小"
                />
                <StatCard
                  icon="clock-outline"
                  label="近 24 小时更新"
                  value={stats ? `${stats.updatedLast24h} 条` : '—'}
                  hint="按记录写入时间统计"
                />
                <StatCard
                  icon="history"
                  label="最近写入"
                  value={stats?.lastUpdated ? relativeTime(stats.lastUpdated) : '—'}
                  hint={stats?.lastUpdated ? formatTime(stats.lastUpdated) : '暂无数据'}
                />
              </div>

              <div className="admin-two-col">
                <section className="v-card admin-card">
                  <div className="admin-card-head">
                    <h2 className="text-subtitle-1 font-weight-medium">数据分组</h2>
                    <span className="text-caption text-medium-emphasis">按键名前缀归类</span>
                  </div>
                  <div className="admin-card-body">
                    {stats && stats.groups.length > 0 ? (
                      stats.groups.map((item) => {
                        const percent = Math.max(
                          4,
                          Math.round((item.bytes / maxGroupBytes) * 100),
                        )
                        return (
                          <div className="admin-group-row" key={item.id}>
                            <div className="admin-group-meta">
                              <span>{item.label}</span>
                              <span className="text-caption text-medium-emphasis">
                                {item.keys} 个 · {formatBytes(item.bytes)}
                              </span>
                            </div>
                            <div className="admin-bar">
                              <span style={{ width: `${percent}%` }} />
                            </div>
                          </div>
                        )
                      })
                    ) : (
                      <div className="admin-empty">暂无数据</div>
                    )}
                  </div>
                </section>

                <section className="v-card admin-card">
                  <div className="admin-card-head">
                    <h2 className="text-subtitle-1 font-weight-medium">最近操作</h2>
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-text"
                      onClick={() => selectTab('logs')}
                    >
                      全部日志
                      <MdiIcon name="chevron-right" size={16} />
                    </button>
                  </div>
                  <div className="admin-card-body">
                    {recentLogs.length > 0 ? (
                      recentLogs.map((entry) => (
                        <div className="admin-mini-log" key={entry.id}>
                          <span
                            className={`admin-mini-dot ${
                              entry.action === 'login_failed' || entry.action === 'denied'
                                ? 'admin-mini-dot--error'
                                : ''
                            }`}
                          />
                          <div className="admin-mini-text flex-grow-1">
                            <div>
                              {ACTION_LABELS[entry.action] ?? entry.action}
                              {entry.key ? (
                                <>
                                  {' · '}
                                  <span className="font-monospace">{entry.key}</span>
                                </>
                              ) : null}
                            </div>
                            <div className="admin-mini-time">
                              {formatTime(entry.at)} ·{' '}
                              {entry.actor === 'admin' ? '管理员' : '站点'}
                              {entry.ip ? ` · ${entry.ip}` : ''}
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="admin-empty">暂无日志</div>
                    )}
                  </div>
                </section>
              </div>

              <section className="v-card admin-card">
                <div className="admin-card-head">
                  <h2 className="text-subtitle-1 font-weight-medium">系统信息</h2>
                  <span className="text-caption text-medium-emphasis">服务与会话</span>
                </div>
                <div className="admin-card-body">
                  <div className="admin-info-grid">
                    <div>
                      <div className="admin-info-label">日志保留</div>
                      <div className="admin-info-value">最近 {logLimit} 条</div>
                    </div>
                    <div>
                      <div className="admin-info-label">会话时长</div>
                      <div className="admin-info-value">12 小时（关闭标签页即退出）</div>
                    </div>
                    <div>
                      <div className="admin-info-label">安全提示</div>
                      <div className="admin-info-value">
                        请为管理后台设置强密码，且不要使用示例值
                      </div>
                    </div>
                  </div>
                  <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
                    <button
                      type="button"
                      className="v-btn v-btn--variant-tonal"
                      data-color="primary"
                      onClick={() => void exportBackup()}
                      disabled={exporting}
                    >
                      <MdiIcon name="file-export-outline" size={18} />
                      {exporting ? '导出中…' : '导出全站备份'}
                    </button>
                    <button
                      type="button"
                      className="v-btn v-btn--variant-outlined"
                      onClick={() => void loadOverview()}
                      disabled={busy}
                    >
                      <MdiIcon name="refresh" size={18} />
                      刷新统计
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {tab === 'data' && (
            <>
              <div className="admin-toolbar">
                <div className="admin-search">
                  <MdiIcon name="magnify" size={18} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索数据键"
                    aria-label="搜索数据键"
                  />
                </div>
                <div className="admin-chips">
                  {GROUPS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`admin-chip ${group === item.id ? 'active' : ''}`}
                      onClick={() => setGroup(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="admin-toolbar-actions">
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => void loadKeys()}
                    disabled={busy}
                  >
                    <MdiIcon name="refresh" size={16} />
                    刷新
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => void exportBackup()}
                    disabled={exporting}
                  >
                    <MdiIcon name="file-export-outline" size={16} />
                    {exporting ? '导出中…' : '导出备份'}
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    data-color="primary"
                    onClick={openImport}
                  >
                    <MdiIcon name="file-import-outline" size={16} />
                    云端导入
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    onClick={openCreate}
                  >
                    <MdiIcon name="plus" size={16} />
                    新建数据键
                  </button>
                </div>
              </div>

              {keysHasMore && (
                <div className="v-alert v-alert--variant-tonal mb-3" data-color="warning">
                  <MdiIcon name="alert-circle-outline" size={20} />
                  <div className="flex-grow-1">
                    <div>
                      已加载 {keys?.length ?? 0} / {keysTotal} 个数据键。搜索与分组筛选仅覆盖已加载的数据。
                    </div>
                    <div className="d-flex flex-wrap mt-2" style={{ gap: 8 }}>
                      <button
                        type="button"
                        className="v-btn v-btn--size-small v-btn--variant-outlined"
                        onClick={() => void loadMoreKeys(false)}
                        disabled={keysLoadingMore}
                      >
                        {keysLoadingMore ? '加载中…' : '再加载 500 条'}
                      </button>
                      <button
                        type="button"
                        className="v-btn v-btn--size-small v-btn--variant-text"
                        onClick={() => void loadMoreKeys(true)}
                        disabled={keysLoadingMore}
                      >
                        加载全部
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <section className="v-card admin-card admin-table-card">
                <div className="admin-table-head">
                  <span>数据键</span>
                  <span>分组</span>
                  <span>更新时间</span>
                  <span>大小</span>
                  <span style={{ textAlign: 'right' }}>操作</span>
                </div>

                {keys === null ? (
                  <div className="admin-empty">正在加载数据…</div>
                ) : pagedKeys.length === 0 ? (
                  <div className="admin-empty">没有匹配的数据键</div>
                ) : (
                  pagedKeys.map((row) => (
                    <div className="admin-table-row" key={row.key}>
                      <span className="admin-key" title={row.key}>
                        {row.key}
                      </span>
                      <span>
                        <span className="v-chip v-chip--size-small v-chip--variant-tonal">
                          {GROUP_LABELS[row.group] ?? row.group}
                        </span>
                      </span>
                      <span className="admin-cell-time" title={formatTime(row.updatedAt)}>
                        {relativeTime(row.updatedAt)}
                      </span>
                      <span className="admin-cell-size">{formatBytes(row.size)}</span>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="v-btn v-btn--icon v-btn--variant-text"
                          onClick={() => void openEditor(row)}
                          disabled={openingKey === row.key}
                          title="编辑"
                          aria-label={`编辑 ${row.key}`}
                        >
                          <MdiIcon
                            name={openingKey === row.key ? 'timer-sand' : 'pencil'}
                            size={18}
                          />
                        </button>
                        <button
                          type="button"
                          className="v-btn v-btn--icon v-btn--variant-text"
                          onClick={() => setDeleteTarget(row)}
                          title="删除"
                          aria-label={`删除 ${row.key}`}
                        >
                          <MdiIcon name="delete" size={18} />
                        </button>
                      </div>
                    </div>
                  ))
                )}

                <div className="admin-pagination">
                  <span className="text-caption text-medium-emphasis">
                    已加载 {keys?.length ?? 0}
                    {keysTotal ? ` / ${keysTotal}` : ''} 条 · 当前筛选 {filteredKeys.length} 条 · 第{' '}
                    {currentPage + 1} / {pageCount} 页
                  </span>
                  <div className="admin-pagination-actions">
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--variant-text"
                      onClick={() => setPage((value) => Math.max(0, value - 1))}
                      disabled={currentPage === 0}
                      title="上一页"
                      aria-label="上一页"
                    >
                      <MdiIcon name="chevron-left" size={18} />
                    </button>
                    <button
                      type="button"
                      className="v-btn v-btn--icon v-btn--variant-text"
                      onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                      disabled={currentPage >= pageCount - 1}
                      title="下一页"
                      aria-label="下一页"
                    >
                      <MdiIcon name="chevron-right" size={18} />
                    </button>
                  </div>
                </div>
              </section>
            </>
          )}

          {token && importVisited && (
            <div hidden={tab !== 'import'}>
              <UpstreamImportPanel
                adminToken={token}
                onChanged={() => {
                  // 导入后让数据/日志页按需重新读取，避免展示旧列表
                  setKeys(null)
                  setKeysTotal(0)
                  setKeysHasMore(false)
                  setKeysNextOffset(0)
                  setLogs(null)
                  void loadOverview(false)
                }}
                onOpenData={() => selectTab('data')}
                onAuthError={(err) => {
                  handleAuthError(err)
                }}
              />
            </div>
          )}

          {tab === 'logs' && (
            <>
              <div className="admin-toolbar">
                <div className="admin-search">
                  <MdiIcon name="magnify" size={18} />
                  <input
                    value={logQuery}
                    onChange={(event) => setLogQuery(event.target.value)}
                    placeholder="搜索操作、数据键、IP"
                    aria-label="搜索日志"
                  />
                </div>
                <div className="admin-chips">
                  {(
                    [
                      { id: 'all', label: '全部' },
                      { id: 'admin', label: '管理员' },
                      { id: 'site', label: '站点' },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`admin-chip ${logActor === item.id ? 'active' : ''}`}
                      onClick={() => setLogActor(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="admin-toolbar-actions">
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => void loadLogs()}
                    disabled={busy}
                  >
                    <MdiIcon name="refresh" size={16} />
                    刷新
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    data-color="error"
                    onClick={() => setClearOpen(true)}
                    disabled={!logs || logs.length === 0}
                  >
                    <MdiIcon name="delete" size={16} />
                    清空日志
                  </button>
                </div>
              </div>

              <section className="v-card admin-card admin-table-card">
                <div className="admin-log-head">
                  <span>时间</span>
                  <span>来源</span>
                  <span>操作</span>
                  <span>数据键 / 说明</span>
                  <span>IP</span>
                </div>

                {logs === null ? (
                  <div className="admin-empty">正在加载日志…</div>
                ) : filteredLogs.length === 0 ? (
                  <div className="admin-empty">暂无日志</div>
                ) : (
                  filteredLogs.map((entry) => (
                    <div className="admin-log-row" key={entry.id}>
                      <span className="admin-log-time">{formatTime(entry.at)}</span>
                      <span>
                        <span
                          className={`admin-badge ${
                            entry.actor === 'admin' ? 'admin-badge--admin' : ''
                          }`}
                        >
                          {entry.actor === 'admin' ? '管理员' : '站点'}
                        </span>
                      </span>
                      <span className={`admin-action admin-action--${entry.action}`}>
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                      <span className="admin-log-key" title={entry.note ?? entry.key}>
                        {entry.key ?? entry.note ?? '—'}
                      </span>
                      <span className="admin-log-ip" title={entry.ua}>
                        {entry.ip ?? '—'}
                      </span>
                    </div>
                  ))
                )}

                <div className="admin-pagination">
                  <span className="text-caption text-medium-emphasis">
                    共 {filteredLogs.length} 条 · 最多保留最近 {logLimit} 条
                  </span>
                </div>
              </section>
            </>
          )}
        </div>
      </div>

      <Modal
        open={Boolean(editor)}
        onClose={closeEditor}
        title={<span className="text-h6">{editor?.mode === 'create' ? '新建数据键' : '编辑数据'}</span>}
        subtitle={
          editor?.mode === 'edit'
            ? `${GROUP_LABELS[editor.group ?? 'other'] ?? '其他'} · ${formatBytes(editor.size ?? 0)} · 更新于 ${formatTime(editor.baseUpdatedAt)}`
            : '新记录包含数据内容与更新时间'
        }
        width={760}
        fullscreenOnMobile
        closable={!saving}
        maskClosable={false}
        footer={
          <>
            {editor?.mode === 'edit' && (
              <button
                type="button"
                className="v-btn v-btn--variant-tonal"
                data-color="error"
                disabled={saving || editor.baseUpdatedAt === undefined}
                onClick={() => {
                  setDeleteTarget({
                    key: editor.key,
                    updatedAt: editor.baseUpdatedAt ?? 0,
                    size: editor.size ?? 0,
                    group: editor.group ?? 'other',
                  })
                }}
              >
                <MdiIcon name="delete" size={18} />
                删除
              </button>
            )}
            <div className="flex-grow-1" />
            <button
              type="button"
              className="v-btn v-btn--variant-text"
              onClick={closeEditor}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="v-btn v-btn--variant-flat"
              data-color="primary"
              onClick={() => void saveEditor()}
              disabled={saving || Boolean(jsonError) || !editor?.key.trim()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editor && (
          <div className="d-flex flex-column" style={{ gap: 12 }}>
            <label>
              <span className="text-caption text-medium-emphasis">数据键</span>
              <input
                className="v-field mt-2 font-monospace"
                value={editor.key}
                onChange={(event) => setEditor({ ...editor, key: event.target.value })}
                placeholder="例如 classworks-data-20261021"
                disabled={editor.mode === 'edit'}
                spellCheck={false}
              />
            </label>

            <label className="d-flex flex-column" style={{ gap: 8 }}>
              <span className="text-caption text-medium-emphasis">JSON 值</span>
              <textarea
                className="v-field admin-editor font-monospace"
                value={editor.valueText}
                onChange={(event) => setEditor({ ...editor, valueText: event.target.value })}
                spellCheck={false}
              />
            </label>

            {editor.legacy && (
              <div className="v-alert v-alert--variant-tonal rounded-lg" data-color="warning">
                <MdiIcon name="alert-circle-outline" size={20} />
                <div>该记录不是标准的 {'{ "v", "t" }'} 格式，保存后会转换为标准记录。</div>
              </div>
            )}

            {jsonError && editor.valueText.trim() && (
              <div className="admin-json-status text-error">JSON 格式错误：{jsonError}</div>
            )}
            {editorError && <div className="admin-json-status text-error">{editorError}</div>}
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(exportProgress?.open)}
        onClose={() => {
          if (!exporting) setExportProgress(null)
        }}
        title="导出全站备份"
        width={460}
        closable={!exporting}
        maskClosable={false}
        footer={
          <>
            <div className="flex-grow-1" />
            {exporting ? (
              <button
                type="button"
                className="v-btn v-btn--variant-text"
                data-color="error"
                onClick={() => {
                  exportCancelRef.current = true
                  setExportProgress((current) =>
                    current ? { ...current, message: '正在取消…' } : current,
                  )
                }}
              >
                {exportProgress?.message === '正在取消…' ? '正在取消…' : '取消导出'}
              </button>
            ) : (
              <button
                type="button"
                className="v-btn v-btn--variant-flat"
                data-color="primary"
                onClick={() => setExportProgress(null)}
              >
                关闭
              </button>
            )}
          </>
        }
      >
        {exportProgress && (
          <div className="d-flex flex-column" style={{ gap: 14 }}>
            <div className="d-flex align-center" style={{ gap: 10 }}>
              <MdiIcon
                name={
                  exportProgress.status === 'done'
                    ? 'check-circle'
                    : exportProgress.status === 'error'
                      ? 'alert-circle-outline'
                      : 'database'
                }
                size={22}
                className={
                  exportProgress.status === 'done'
                    ? 'text-success'
                    : exportProgress.status === 'error'
                      ? 'text-error'
                      : 'text-primary'
                }
              />
              <div className="text-body-2">
                {exportProgress.status === 'running'
                  ? '正在分页读取全站数据…'
                  : exportProgress.status === 'done'
                    ? '导出完成，下载已开始'
                    : exportProgress.status === 'cancelled'
                      ? '导出已取消'
                      : '导出失败'}
              </div>
            </div>

            <div>

              <div
                className={`v-progress-linear ${
                  exportProgress.status === 'running' && exportProgress.total === 0
                    ? 'v-progress-linear--indeterminate'
                    : ''
                }`}
                style={{ height: 8, borderRadius: 4 }}
              >
                <div
                  className="v-progress-linear__bar"
                  style={{
                    width:
                      exportProgress.total > 0
                        ? `${Math.min(100, (exportProgress.loaded / exportProgress.total) * 100)}%`
                        : undefined,
                    background:
                      exportProgress.status === 'error'
                        ? 'rgb(var(--v-theme-error))'
                        : exportProgress.status === 'done'
                          ? 'rgb(var(--v-theme-success))'
                          : undefined,
                  }}
                />
              </div>
              <div
                className="d-flex justify-space-between text-caption text-medium-emphasis mt-2"
                style={{ gap: 12 }}
              >
                <span>
                  {exportProgress.total > 0
                    ? `${exportProgress.loaded} / ${exportProgress.total} 条`
                    : '正在统计数据量…'}
                </span>
                <span>{formatBytes(exportProgress.bytes)}</span>
              </div>
            </div>

            {exportProgress.message && (
              <div
                className={`text-caption ${
                  exportProgress.status === 'error' ? 'text-error' : 'text-medium-emphasis'
                }`}
              >
                {exportProgress.message}
              </div>
            )}
            {exportProgress.status === 'done' && (
              <div className="text-caption text-medium-emphasis">
                文件包含全部 {exportProgress.loaded} 条数据，可用于迁移或留档。
              </div>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除数据键"
        text={
          <>
            确定删除 <b className="font-monospace">{deleteTarget?.key}</b>？删除后无法恢复。
          </>
        }
        confirmText={deleting ? '删除中…' : '删除'}
        danger
        onCancel={() => {
          if (!deleting) setDeleteTarget(null)
        }}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={clearOpen}
        title="清空操作日志"
        text="将删除全部历史日志（包括管理员与站点操作记录），此操作不可恢复。"
        confirmText={clearing ? '清空中…' : '清空'}
        danger
        onCancel={() => {
          if (!clearing) setClearOpen(false)
        }}
        onConfirm={() => void confirmClearLogs()}
      />
    </>
  )
}

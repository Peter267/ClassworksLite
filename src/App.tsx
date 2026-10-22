import { useCallback, useEffect, useRef, useState } from 'react'
import { AccessGate } from './components/AccessGate'
import { AppBar } from './components/AppBar'
import { Toaster } from './components/ui/Toaster'
import { MessageDrawer } from './components/MessageDrawer'
import { StudentsDialog, SubjectsDialog } from './components/PeopleDialogs'
import { AdminPage } from './pages/Admin'
import { ExamBoard } from './pages/ExamBoard'
import { Home } from './pages/Home'
import { ListPage } from './pages/ListPage'
import { SettingsPage } from './pages/Settings'
import {
  ACCESS_STATUS_EVENT,
  getAccessStatus,
  refreshAccessStatus,
} from './lib/access'
import { useSetting } from './lib/hooks'
import { store } from './lib/store'
import { Icon } from './components/Icon'

type Route = '/' | '/settings' | '/list' | '/exams' | '/admin'
type AccessPhase = 'checking' | 'required' | 'ready' | 'unavailable'

function normalizePath(path: string): Route {
  const clean = path.replace(/\/+$/, '') || '/'
  if (clean === '/settings' || clean === '/list' || clean === '/exams' || clean === '/admin') {
    return clean
  }
  return '/'
}

function useRoute() {
  const [path, setPath] = useState<Route>(() => normalizePath(window.location.pathname))

  useEffect(() => {
    const onPop = () => setPath(normalizePath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, '', next)
    setPath(normalizePath(next))
    window.scrollTo({ top: 0 })
  }, [])

  return { path, navigate }
}

function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', handler)
    return () => document.removeEventListener('fullscreenchange', handler)
  }, [])

  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void document.documentElement.requestFullscreen?.()
    }
  }, [])

  return { isFullscreen, toggle }
}

function useTheme() {
  const [theme] = useSetting<string>('theme.mode')
  const [bgEnabled] = useSetting<boolean>('background.enabled')
  const [bgUrl] = useSetting<string>('background.url')
  const [bgBlur] = useSetting<number>('background.blur')
  const [bgOpacity] = useSetting<number>('background.opacity')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', theme === 'light' ? '#ffffff' : '#212121')
  }, [theme])

  return { bgEnabled, bgUrl, bgBlur, bgOpacity }
}

export default function App() {
  const { path, navigate } = useRoute()
  const { isFullscreen, toggle } = useFullscreen()
  const { bgEnabled, bgUrl, bgBlur, bgOpacity } = useTheme()
  const [cardHover] = useSetting<boolean>('display.cardHoverEffect')

  const [studentsOpen, setStudentsOpen] = useState(false)
  const [subjectsOpen, setSubjectsOpen] = useState(false)
  const [accessPhase, setAccessPhase] = useState<AccessPhase>(() =>
    path === '/admin' ? 'ready' : 'checking',
  )
  const [ready, setReady] = useState(() => path === '/admin')
  const [pendingEdit, setPendingEdit] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)

  const storeStarted = useRef(false)

  const startStore = useCallback(() => {
    if (storeStarted.current) {
      setReady(true)
      return
    }
    storeStarted.current = true
    setReady(false)
    void store.init().finally(() => setReady(true))
  }, [])

  const resumeAfterAccess = useCallback(() => {
    setAccessPhase('ready')
    if (storeStarted.current) {
      setReady(false)
      void store.reinitialize().finally(() => setReady(true))
      return
    }
    startStore()
  }, [startStore])

  useEffect(() => {
    if (path === '/admin') {
      setAccessPhase('ready')
      setReady(true)
      return
    }
    if (storeStarted.current) {
      setReady(true)
      return
    }
    // 访问密码是站点级限制：先确认访问状态，再决定是否加载云端数据
    setAccessPhase('checking')
    let alive = true
    void refreshAccessStatus().then((status) => {
      if (!alive) return
      if (!status) {
        setAccessPhase('unavailable')
        return
      }
      if (status.passwordRequired && !status.authenticated) {
        setAccessPhase('required')
        return
      }
      setAccessPhase('ready')
      startStore()
    })
    return () => {
      alive = false
    }
  }, [path, startStore])

  const retryAccess = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    setAccessPhase('checking')
    void refreshAccessStatus()
      .then((status) => {
        if (!status) {
          setAccessPhase('unavailable')
          return
        }
        if (status.passwordRequired && !status.authenticated) {
          setAccessPhase('required')
          return
        }
        setAccessPhase('ready')
        startStore()
      })
      .finally(() => setRetrying(false))
  }, [retrying, startStore])

  // 会话失效时（令牌过期/被清）立即回到访问门，而不是让页面停在旧数据上
  useEffect(() => {
    const onStatusChange = () => {
      const status = getAccessStatus()
      if (status?.passwordRequired && !status.authenticated) setAccessPhase('required')
    }
    window.addEventListener(ACCESS_STATUS_EVENT, onStatusChange)
    return () => window.removeEventListener(ACCESS_STATUS_EVENT, onStatusChange)
  }, [])

  useEffect(() => {
    const onAccessDenied = () => {
      void refreshAccessStatus().then((status) => {
        if (status?.passwordRequired) setAccessPhase('required')
      })
    }
    window.addEventListener('classworks-lite:access-denied', onAccessDenied)
    return () => window.removeEventListener('classworks-lite:access-denied', onAccessDenied)
  }, [])

  const openSettings = useCallback(() => navigate('/settings'), [navigate])
  const showContent = accessPhase === 'ready'

  return (
    <div className="v-application" data-hover-effect={cardHover ? 'on' : 'off'}>
      {bgEnabled && bgUrl && (
        <>
          <div
            className="app-background-image"
            style={{
              backgroundImage: `url(${bgUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: `blur(${bgBlur}px)`,
              transform: 'scale(1.05)',
            }}
          />
          <div
            className="app-background-overlay"
            style={{ background: `rgba(0,0,0,${bgOpacity / 100})` }}
          />
        </>
      )}

      {showContent && path === '/exams' && (
        <AppBar
          onOpenSettings={openSettings}
          back={{ label: '返回', onBack: () => navigate('/') }}
          title="考试看板"
        />
      )}

      {showContent && path === '/' && (
        <Home
          onOpenSettings={openSettings}
          onNavigate={(target) => navigate(target === 'list' ? '/list' : '/exams')}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggle}
          pendingEdit={pendingEdit}
          onPendingEditHandled={() => setPendingEdit(null)}
        />
      )}

      {showContent && path === '/settings' && (
        <SettingsPage
          onBack={() => navigate('/')}
          openStudents={() => setStudentsOpen(true)}
          openSubjects={() => setSubjectsOpen(true)}
          openExams={() => navigate('/exams')}
          openAdmin={() => navigate('/admin')}
        />
      )}

      {showContent && path === '/admin' && <AdminPage onBack={() => navigate('/')} />}

      {showContent && path === '/list' && (
        <ListPage
          onBack={() => navigate('/')}
          onEdit={(subject) => {
            setPendingEdit(subject)
            navigate('/')
          }}
        />
      )}

      {showContent && path === '/exams' && <ExamBoard onBack={() => navigate('/')} />}

      {showContent && (
        <>
          <StudentsDialog open={studentsOpen} onClose={() => setStudentsOpen(false)} />
          <SubjectsDialog open={subjectsOpen} onClose={() => setSubjectsOpen(false)} />
          <MessageDrawer />
        </>
      )}
      <Toaster />

      {accessPhase === 'required' && <AccessGate onUnlocked={resumeAfterAccess} />}

      {accessPhase === 'unavailable' && (
        <div className="access-gate-wrap">
          <div className="access-gate-card">
            <span className="access-gate-icon">
              <Icon name="cloudOff" size={30} />
            </span>
            <div role="alert">
              <h1 className="text-h5">无法连接服务器</h1>
              <p className="text-body-2 text-medium-emphasis mt-2">
                请检查网络后重试；若持续失败，请联系班级管理员确认站点状态。
              </p>
            </div>
            <button
              type="button"
              className="v-btn v-btn--variant-flat v-btn--size-large w-full mt-5"
              data-color="primary"
              onClick={retryAccess}
              disabled={retrying}
            >
              {retrying ? '重试中…' : '重试'}
            </button>
          </div>
        </div>
      )}

      {(accessPhase === 'checking' || (showContent && !ready)) && (
        <div
          className="v-overlay"
          style={{ background: 'rgb(var(--v-theme-background))', zIndex: 3000 }}
          role="status"
          aria-live="polite"
        >
          <div className="d-flex flex-column align-center" style={{ gap: 12 }}>
            <div className="loading-spinner" />
            <span className="text-caption text-medium-emphasis">
              {accessPhase === 'checking' ? '正在验证访问权限…' : '正在加载作业板…'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

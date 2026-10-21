import { useCallback, useEffect, useRef, useState } from 'react'
import { AppBar } from './components/AppBar'
import { Toaster } from './components/ui/Toaster'
import { MessageDrawer } from './components/MessageDrawer'
import { StudentsDialog, SubjectsDialog } from './components/PeopleDialogs'
import { AdminPage } from './pages/Admin'
import { ExamBoard } from './pages/ExamBoard'
import { Home } from './pages/Home'
import { ListPage } from './pages/ListPage'
import { SettingsPage } from './pages/Settings'
import { useSetting } from './lib/hooks'
import { store } from './lib/store'

type Route = '/' | '/settings' | '/list' | '/exams' | '/admin'

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
  const [ready, setReady] = useState(() => path === '/admin')
  const [pendingEdit, setPendingEdit] = useState<string | null>(null)

  const storeStarted = useRef(false)
  useEffect(() => {
    if (path === '/admin') {
      setReady(true)
      return
    }
    if (storeStarted.current) return
    storeStarted.current = true
    setReady(false)
    void store.init().finally(() => setReady(true))
  }, [path])

  useEffect(() => () => store.destroy(), [])

  const openSettings = useCallback(() => navigate('/settings'), [navigate])

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

      {path === '/exams' && (
        <AppBar
          onOpenSettings={openSettings}
          back={{ label: '返回', onBack: () => navigate('/') }}
          title="考试看板"
        />
      )}

      {path === '/' && (
        <Home
          onOpenSettings={openSettings}
          onNavigate={(target) => navigate(target === 'list' ? '/list' : '/exams')}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggle}
          pendingEdit={pendingEdit}
          onPendingEditHandled={() => setPendingEdit(null)}
        />
      )}

      {path === '/settings' && (
        <SettingsPage
          onBack={() => navigate('/')}
          openStudents={() => setStudentsOpen(true)}
          openSubjects={() => setSubjectsOpen(true)}
          openExams={() => navigate('/exams')}
          openAdmin={() => navigate('/admin')}
        />
      )}

      {path === '/admin' && <AdminPage onBack={() => navigate('/')} />}

      {path === '/list' && (
        <ListPage
          onBack={() => navigate('/')}
          onEdit={(subject) => {
            setPendingEdit(subject)
            navigate('/')
          }}
        />
      )}

      {path === '/exams' && <ExamBoard onBack={() => navigate('/')} />}

      <StudentsDialog open={studentsOpen} onClose={() => setStudentsOpen(false)} />
      <SubjectsDialog open={subjectsOpen} onClose={() => setSubjectsOpen(false)} />
      <Toaster />
      <MessageDrawer />

      {!ready && (
        <div
          className="v-overlay"
          style={{ background: 'rgb(var(--v-theme-background))', zIndex: 3000 }}
        >
          <div className="d-flex flex-column align-center" style={{ gap: 12 }}>
            <div className="loading-spinner" />
            <span className="text-caption text-medium-emphasis">正在加载作业板…</span>
          </div>
        </div>
      )}
    </div>
  )
}

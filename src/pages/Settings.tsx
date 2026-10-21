import { useEffect, useState } from 'react'
import { AppBar } from '../components/AppBar'
import { MdiIcon } from '../components/MdiIcon'
import { AccessSettingsCard } from '../components/settings/AccessSettingsCard'
import { NoiseSettingsCard } from '../components/settings/NoiseSettingsCard'
import { SettingItem } from '../components/settings/SettingItem'
import { SettingsCard } from '../components/settings/SettingsCard'
import { Modal } from '../components/ui/Modal'
import { relativeTime } from '../lib/date'
import { useAppState, useSettingsVersion } from '../lib/hooks'
import { cacheClear } from '../lib/cache'
import { getClient } from '../lib/kv'
import { SETTING_DEFS, settings } from '../lib/settings'
import { store } from '../lib/store'
import { toast } from '../lib/toast'

type TabKey =
  | 'home'
  | 'server'
  | 'subject'
  | 'roster'
  | 'refresh'
  | 'edit'
  | 'display'
  | 'noise'
  | 'hitokoto'
  | 'random'
  | 'background'
  | 'developer'
  | 'about'

const TABS: { key: TabKey; title: string; icon: string }[] = [
  { key: 'home', title: '首页', icon: 'home' },
  { key: 'server', title: '服务器', icon: 'server' },
  { key: 'subject', title: '科目', icon: 'book-edit' },
  { key: 'roster', title: '花名册', icon: 'account-group' },
  { key: 'refresh', title: '刷新', icon: 'refresh' },
  { key: 'edit', title: '编辑', icon: 'pencil' },
  { key: 'display', title: '显示', icon: 'eye' },
  { key: 'noise', title: '噪音监测', icon: 'microphone' },
  { key: 'hitokoto', title: '一言', icon: 'comment-quote' },
  { key: 'random', title: '随机点名', icon: 'dice-multiple' },
  { key: 'background', title: '背景', icon: 'image' },
  { key: 'developer', title: '开发者', icon: 'developer-board' },
  { key: 'about', title: '关于', icon: 'information' },
]

const GROUP_SETTINGS: Partial<Record<TabKey, string[]>> = {
  refresh: ['refresh.auto', 'refresh.interval', 'sync.realtime'],
  edit: [
    'edit.autoSave',
    'edit.blockNonTodayAutoSave',
    'edit.confirmNonTodaySave',
    'edit.blockPastDataEdit',
    'edit.autoSavePromptText',
    'edit.manualSavePromptText',
    'edit.canvasClickClose',
  ],
  display: [
    'timeCard.enabled',
    'display.emptySubjectDisplay',
    'display.showRandomButton',
    'display.showFullscreenButton',
    'display.cardHoverEffect',
    'display.showQuickTools',
    'display.showPasteButtons',
    'display.showAntiScreenBurnCard',
    'display.showExamScheduleButton',
    'display.showUafTransfer',
    'display.forceDesktopMode',
    'display.lateStudentsArePresent',
  ],
  hitokoto: ['hitokoto.enabled', 'hitokoto.online', 'hitokoto.refreshInterval'],
  random: [
    'randomPicker.enabled',
    'randomPicker.mode',
    'randomPicker.minNumber',
    'randomPicker.maxNumber',
    'randomPicker.defaultCount',
    'randomPicker.animation',
    'randomPicker.excludeAbsent',
    'randomPicker.excludeLate',
    'randomPicker.excludeExcluded',
  ],
  background: ['background.enabled', 'background.url', 'background.blur', 'background.opacity'],
  server: ['server.provider', 'server.domain', 'server.siteKey', 'server.classNumber'],
}

const GROUP_CARD: Partial<Record<TabKey, { title: string; icon: string }>> = {
  refresh: { title: '刷新设置', icon: 'refresh-circle' },
  edit: { title: '编辑设置', icon: 'cog' },
  hitokoto: { title: '一言设置', icon: 'comment-quote' },
  random: { title: '随机点名设置', icon: 'dice-multiple' },
  background: { title: '背景设置', icon: 'image' },
}

interface SettingsPageProps {
  onBack: () => void
  openStudents: () => void
  openSubjects: () => void
  openExams: () => void
  openAdmin: () => void
}

export function SettingsPage({
  onBack,
  openStudents,
  openSubjects,
  openExams,
  openAdmin,
}: SettingsPageProps) {
  useSettingsVersion()
  const state = useAppState()
  const [active, setActive] = useState<TabKey>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    return TABS.find((tab) => tab.key === requested)?.key ?? 'home'
  })
  const [resetOpen, setResetOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [active])

  const dev = settings.get<boolean>('developer.enabled')
  const provider = settings.get<string>('server.provider')
  const theme = settings.get<string>('theme.mode')

  const renderList = (keys: string[]) => (
    <div className="v-list">
      {keys
        .filter((key) => SETTING_DEFS[key])
        .map((key, index) => (
          <div key={key}>
            {index > 0 && <hr className="v-divider" style={{ margin: '8px 0' }} />}
            <SettingItem settingKey={key} />
          </div>
        ))}
    </div>
  )

  return (
    <>
      <AppBar
        title="设置"
        back={{ label: '返回', onBack }}
        onMenu={() => setDrawerOpen((open) => !open)}
        menuExpanded={drawerOpen}
        hideSettings
        hideBell
        elevation={1}
      />

      <div className="settings-page">
        <nav className={`settings-drawer ${drawerOpen ? 'open' : ''}`} aria-label="设置分类">
          <div className="v-list">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`v-list-item ${active === tab.key ? 'v-list-item--active' : ''}`}
                aria-current={active === tab.key ? 'page' : undefined}
                onClick={() => {
                  setActive(tab.key)
                  setDrawerOpen(false)
                }}
              >
                <MdiIcon name={tab.icon} size={24} />
                <span className="v-list-item-title">{tab.title}</span>
              </button>
            ))}
          </div>
        </nav>

        {drawerOpen && <div className="settings-scrim" onClick={() => setDrawerOpen(false)} />}

        <div className="settings-content">
          {active === 'home' && (
            <>
              <SettingsCard title="ClassworksLite" subtitle="设置" className="rounded-xl">
                <div className="text-body-2">
                  <p className="mb-3">
                    ClassworksLite 是基于{' '}
                    <a href="https://github.com/Moonrend/Classworks" target="_blank" rel="noreferrer">
                      Classworks
                    </a>{' '}
                    二次开发的开源作业板。界面文案、Material 3 视觉与数据键名与上游保持一致，
                    后端改为单个 KV 函数，可直接部署到 Cloudflare Pages、Cloudflare Workers 或 Vercel。
                  </p>
                  <div className="d-flex flex-column" style={{ gap: 6 }}>
                    <div>· 上游：Classworks（AGPL-3.0，作者 SunWuyuan / ZeroCat 社区）</div>
                    <div>· 本版本：React 19 + Vite + 单函数 KV，新增 UAF 导入导出、环境噪音监测与密码保护的管理后台</div>
                    <div>· 数据兼容：沿用 <code>classworks-data-YYYYMMDD</code> 等键名，可直接读取上游数据</div>
                    <div>· 项目说明与部署方式见仓库根目录的 README.md 与 NOTICE.md</div>
                  </div>
                </div>
              </SettingsCard>

              <SettingsCard title="二次开发说明" icon="developer-board" className="rounded-xl">
                <div className="text-body-2">
                  <p className="mb-3">
                    ClassworksLite 以二次开发为目标组织代码，修改时按下面的入口定位：
                  </p>
                  <div className="d-flex flex-column" style={{ gap: 6 }}>
                    <div>· 页面与组件：<code>src/pages</code>、<code>src/components</code></div>
                    <div>· 设置项：<code>src/lib/settings.ts</code>（键名、默认值、分组、标题）</div>
                    <div>· 主题与组件样式：<code>src/index.css</code>（<code>--v-theme-*</code> 令牌）</div>
                    <div>· 数据与同步：<code>src/lib/store.ts</code>、<code>src/lib/kv.ts</code></div>
                    <div>· 服务端：<code>server/kv-core.ts</code> 与 <code>functions</code> / <code>worker</code> / <code>api</code> 适配器</div>
                    <div>· 管理后台：<code>src/pages/Admin.tsx</code>、<code>server/admin-core.ts</code>（环境变量 <code>ADMIN_PASSWORD</code>）</div>
                    <div>· UAF：<code>src/lib/uafExport.ts</code>；噪音：<code>src/lib/noise.ts</code></div>
                  </div>
                  <p className="mt-3 mb-2">
                    品牌名称统一写作 <b>ClassworksLite</b>（站点标题、PWA manifest、README、NOTICE）。
                    对外分发修改版时，请保留 <code>LICENSE</code> 与 <code>NOTICE.md</code>，并按 AGPL-3.0 提供对应源码。
                  </p>
                  <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                    <a
                      className="v-btn v-btn--size-small v-btn--variant-tonal"
                      data-color="primary"
                      href="https://github.com/Moonrend/Classworks"
                      target="_blank"
                      rel="noreferrer"
                    >
                      上游仓库
                      <MdiIcon name="open-in-new" size={18} />
                    </a>
                    <span className="v-chip v-chip--size-small v-chip--variant-tonal">AGPL-3.0</span>
                    <span className="v-chip v-chip--size-small v-chip--variant-tonal">React 19</span>
                    <span className="v-chip v-chip--size-small v-chip--variant-tonal">Serverless KV</span>
                  </div>
                </div>
              </SettingsCard>

              <SettingsCard title="使用提示" icon="information" className="rounded-xl">
                <div className="v-alert v-alert--variant-tonal rounded-xl" data-color="info">
                  <MdiIcon name="information" size={20} />
                  <div>
                    请不要使用浏览器清除缓存功能，否则会导致配置丢失。
                    <del>恶意的操作可能导致您受到贵校教师的处理</del>
                  </div>
                </div>
                <div className="v-alert v-alert--variant-tonal rounded-xl mt-4" data-color="warning">
                  <MdiIcon name="information" size={20} />
                  <div>
                    <p className="mb-2">
                      请不要使用包括但不限于360极速浏览器、360安全浏览器、夸克浏览器、QQ浏览器等浏览器使用
                      ClassworksLite，这些浏览器过时且存在严重的一致性问题。在Windows上，使用新版
                      Microsoft Edge 浏览器是最推荐的选择。
                    </p>
                    <p style={{ opacity: 0.75 }}>
                      上述浏览器商标为其所属公司所有，ClassworksLite 与上述浏览器所属公司无竞争关系。
                    </p>
                    <a
                      className="v-btn v-btn--variant-tonal rounded-xl mt-3"
                      data-color="warning"
                      href="https://www.microsoft.com/zh-cn/windows/microsoft-edge"
                      target="_blank"
                      rel="noreferrer"
                    >
                      下载 Microsoft Edge（微软边缘浏览器）
                      <MdiIcon name="open-in-new" size={18} />
                    </a>
                  </div>
                </div>
              </SettingsCard>
            </>
          )}

          {active === 'server' && (
            <>
              <SettingsCard title="连接状态" icon="cloud" subtitle="云端模式会把作业数据写入部署好的 /api/kv 接口">
                <div className="grid grid-cols-2 sm:grid-cols-4" style={{ gap: 12 }}>
                  {[
                    { label: '存储模式', value: provider === 'cloud' ? '服务器' : '本地数据库' },
                    {
                      label: '同步状态',
                      value: state.saving
                        ? '写入中'
                        : state.dirty
                          ? '待上传'
                          : state.offline
                            ? '离线缓存'
                            : '已同步',
                    },
                    { label: '待补传', value: `${state.pendingSync} 条` },
                    {
                      label: '最后更新',
                      value: state.updatedAt ? relativeTime(state.updatedAt) : '—',
                    },
                  ].map((item) => (
                    <div key={item.label}>
                      <div className="text-caption text-medium-emphasis">{item.label}</div>
                      <div className="mt-1 text-body-2 font-weight-medium">{item.value}</div>
                    </div>
                  ))}
                </div>
                <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    data-color="primary"
                    onClick={async () => {
                      const ok = await store.reinitialize()
                      if (ok) toast.success('已重新连接', '配置已生效')
                    }}
                  >
                    <MdiIcon name="refresh" size={18} />
                    应用并重连
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => void store.refresh()}
                  >
                    立即拉取
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    onClick={() => void store.save({ silent: false })}
                  >
                    立即上传
                  </button>
                </div>
              </SettingsCard>

              <AccessSettingsCard />

              <SettingsCard title="数据源设置" icon="database">
                {renderList(GROUP_SETTINGS.server ?? [])}
              </SettingsCard>

              <SettingsCard
                title="管理后台"
                icon="shield-key"
                subtitle="查看全站数据、操作日志并导出备份，需要服务端配置 ADMIN_PASSWORD"
              >
                <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    data-color="primary"
                    onClick={openAdmin}
                  >
                    <MdiIcon name="shield-key" size={18} />
                    打开管理后台
                  </button>
                  <a
                    className="v-btn v-btn--size-small v-btn--variant-outlined"
                    href={`${window.location.origin}/admin`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MdiIcon name="open-in-new" size={18} />
                    新标签页打开
                  </a>
                </div>
              </SettingsCard>
            </>
          )}

          {active === 'subject' && (
            <SettingsCard
              title="科目管理"
              icon="book-multiple"
              action={
                <button type="button" className="v-btn v-btn--size-small v-btn--variant-tonal" data-color="primary" onClick={openSubjects}>
                  管理科目
                </button>
              }
            >
              <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                {state.subjects.map((subject) => (
                  <span key={subject.name} className="v-chip v-chip--variant-tonal" data-color="primary">
                    {subject.name}
                  </span>
                ))}
              </div>
              <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
                <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={openSubjects}>
                  <MdiIcon name="pencil" size={18} />
                  科目管理
                </button>
                <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={openExams}>
                  <MdiIcon name="calendar" size={18} />
                  考试看板
                </button>
              </div>
            </SettingsCard>
          )}

          {active === 'roster' && (
            <SettingsCard
              title="花名册"
              icon="account-group"
              action={
                <button type="button" className="v-btn v-btn--size-small v-btn--variant-tonal" data-color="primary" onClick={openStudents}>
                  管理名单
                </button>
              }
            >
              <div className="text-body-2 mb-2">共 {state.students.length} 人</div>
              <div className="d-flex flex-wrap" style={{ gap: 6 }}>
                {state.students.map((name) => (
                  <span key={name} className="v-chip v-chip--size-small v-chip--variant-tonal">
                    {name}
                  </span>
                ))}
              </div>
            </SettingsCard>
          )}

          {active === 'display' && (
            <>
            <SettingsCard title="显示设置" icon="monitor">
              <div className="v-list">
                <div className="v-list-item setting-theme-row">
                  <MdiIcon name="theme-light-dark" size={21} className="setting-theme-icon" />
                  <div className="setting-title">
                    <div className="v-list-item-title">主题模式</div>
                    <div className="v-list-item-subtitle">选择明亮或暗黑主题</div>
                  </div>
                  <div className="theme-toggle" role="group" aria-label="主题模式">
                    <button
                      type="button"
                      className={theme === 'light' ? 'active' : ''}
                      aria-pressed={theme === 'light'}
                      onClick={() => settings.set('theme.mode', 'light')}
                    >
                      <MdiIcon name="white-balance-sunny" size={18} />
                      明亮
                    </button>
                    <button
                      type="button"
                      className={theme === 'dark' ? 'active' : ''}
                      aria-pressed={theme === 'dark'}
                      onClick={() => settings.set('theme.mode', 'dark')}
                    >
                      <MdiIcon name="moon-waning-crescent" size={18} />
                      暗黑
                    </button>
                  </div>
                </div>
                {(GROUP_SETTINGS.display ?? []).map((key) => (
                  <div key={key}>
                    <hr className="v-divider" style={{ margin: '8px 0' }} />
                    <SettingItem settingKey={key} />
                  </div>
                ))}
              </div>
            </SettingsCard>

            <SettingsCard title="本地扩展" icon="cog">
              <div className="v-list">
                {['font.size', 'display.showListCard', 'timeCard.use12h'].map((key, index) => (
                  <div key={key}>
                    {index > 0 && <hr className="v-divider" style={{ margin: '8px 0' }} />}
                    <SettingItem settingKey={key} />
                  </div>
                ))}
              </div>
            </SettingsCard>
            </>
          )}

          {active === 'noise' && <NoiseSettingsCard />}

          {active === 'developer' && (
            <>
              <SettingsCard title="开发者选项" icon="test-tube">
                <div className="v-list">
                  <SettingItem
                    settingKey="developer.enabled"
                    description="启用后可以查看和修改开发者设置"
                  />
                </div>
              </SettingsCard>
              {dev && (
                <SettingsCard title="开发者设置" icon="cog">
                  <div className="v-list">
                    <SettingItem settingKey="developer.showTestCard" />
                  </div>
                </SettingsCard>
              )}
              <SettingsCard title="危险操作" icon="alert-circle">
                <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                  <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={() => setResetOpen(true)}>
                    恢复默认设置
                  </button>
                  <button
                    type="button"
                    className="v-btn v-btn--size-small v-btn--variant-tonal"
                    data-color="error"
                    onClick={async () => {
                      const local = settings.get<string>('server.provider') === 'local'
                      let pending = 0
                      try {
                        pending = await getClient().pendingCount()
                      } catch {
                        /* ignore */
                      }
                      const message = local
                        ? '当前是本地数据库模式，清除后所有本地作业数据都会丢失，确定继续吗？'
                        : pending > 0
                          ? `当前有 ${pending} 条尚未同步的离线改动，清除后也会丢失。确定继续吗？`
                          : '清除本地缓存后需要重新从云端拉取数据，确定继续吗？'
                      if (!window.confirm(message)) return
                      await cacheClear()
                      toast.success(
                        '已清除本地缓存',
                        local ? '本地数据已清空' : '云端数据不受影响，刷新后会重新拉取',
                      )
                      window.setTimeout(() => window.location.reload(), 900)
                    }}
                  >
                    清除本地缓存
                  </button>
                </div>
              </SettingsCard>
            </>
          )}

          {GROUP_CARD[active as TabKey] && (
            <SettingsCard
              title={GROUP_CARD[active as TabKey]!.title}
              icon={GROUP_CARD[active as TabKey]!.icon}
            >
              {renderList(GROUP_SETTINGS[active] ?? [])}
            </SettingsCard>
          )}

          {active === 'about' && (
            <SettingsCard title="关于" icon="information" className="rounded-xl">
              <div className="text-body-2">
                <p className="mb-3">
                  本项目是{' '}
                  <a href="https://github.com/Moonrend/Classworks" target="_blank" rel="noreferrer">
                    Classworks
                  </a>{' '}
                  的 Serverless 重写版本：保留作业板、出勤、考试、随机点名、UAF 导入导出与环境噪音监测等核心交互，
                  把原先需要常驻 Express + PostgreSQL + Socket.IO 的后端换成静态前端加上单个 KV 函数，
                  可直接部署到 Cloudflare Pages、Vercel 或任意静态托管。
                </p>
                <div className="grid sm:grid-cols-2" style={{ gap: 8 }}>
                  {[
                    ['数据存储', provider === 'cloud' ? 'Serverless KV' : 'localStorage（本地）'],
                    ['离线能力', 'PWA 缓存 + 离线写入队列'],
                    ['多端同步', 'BroadcastChannel + 增量轮询'],
                    ['依赖', '零后端依赖，单函数即可上线'],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-lg px-3 py-2" style={{ background: 'rgba(var(--v-theme-surface-variant), 0.2)' }}>
                      <div className="text-caption text-medium-emphasis">{label}</div>
                      <div className="mt-1 font-weight-medium">{value}</div>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-medium-emphasis">
                  原项目遵循 AGPL-3.0，本项目同样以 AGPL-3.0 发布。
                </p>
              </div>
            </SettingsCard>
          )}
        </div>
      </div>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title={<span className="text-h6">恢复默认设置</span>}
        width={420}
        footer={
          <>
            <div className="flex-grow-1" />
            <button type="button" className="v-btn v-btn--variant-text" onClick={() => setResetOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="v-btn v-btn--variant-flat"
              data-color="error"
              onClick={() => {
                settings.resetAll()
                setResetOpen(false)
                toast.success('已恢复默认设置')
              }}
            >
              确认恢复
            </button>
          </>
        }
      >
        <p className="text-body-2">
          所有设置项将回到初始值（包括服务器地址、站点令牌与编辑令牌），并切回本地数据库模式；
          作业数据、学生名单与科目本身不会被删除。
        </p>
      </Modal>
    </>
  )
}

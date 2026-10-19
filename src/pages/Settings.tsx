import { useEffect, useState } from 'react'
import { AppBar } from '../components/AppBar'
import { Icon, type IconName } from '../components/Icon'
import { NoiseSettingsCard } from '../components/settings/NoiseSettingsCard'
import { SettingItem } from '../components/settings/SettingItem'
import { SettingsCard } from '../components/settings/SettingsCard'
import { Modal } from '../components/ui/Modal'
import { relativeTime } from '../lib/date'
import { useAppState, useSettingsVersion } from '../lib/hooks'
import { cacheClear } from '../lib/cache'
import { GROUP_LABELS, SETTING_DEFS, settings, type SettingGroup } from '../lib/settings'
import { store } from '../lib/store'
import { toast } from '../lib/toast'

type TabKey = SettingGroup | 'about'

const TABS: { key: TabKey; title: string; icon: IconName }[] = [
  { key: 'home', title: '首页', icon: 'grid' },
  { key: 'server', title: '服务器', icon: 'server' },
  { key: 'subject', title: '科目', icon: 'book' },
  { key: 'roster', title: '花名册', icon: 'users' },
  { key: 'refresh', title: '刷新', icon: 'refresh' },
  { key: 'edit', title: '编辑', icon: 'edit' },
  { key: 'display', title: '显示', icon: 'eye' },
  { key: 'noise', title: '噪音监测', icon: 'microphone' },
  { key: 'hitokoto', title: '一言', icon: 'quote' },
  { key: 'random', title: '随机点名', icon: 'shuffle' },
  { key: 'background', title: '背景', icon: 'image' },
  { key: 'developer', title: '开发者', icon: 'settings' },
  { key: 'about', title: '关于', icon: 'info' },
]

const GROUP_SETTINGS: Partial<Record<TabKey, string[]>> = {
  refresh: ['refresh.auto', 'refresh.interval', 'sync.realtime'],
  edit: [
    'edit.autoSave',
    'edit.blockNonTodayAutoSave',
    'edit.refreshBeforeEdit',
    'edit.confirmNonTodaySave',
    'edit.blockPastDataEdit',
    'edit.autoSavePromptText',
    'edit.manualSavePromptText',
    'edit.canvasClickClose',
  ],
  display: [
    'theme.mode',
    'font.size',
    'display.emptySubjectDisplay',
    'display.dynamicSort',
    'display.showRandomButton',
    'display.showFullscreenButton',
    'display.cardHoverEffect',
    'display.enhancedTouchMode',
    'display.showAntiScreenBurnCard',
    'display.showListCard',
    'display.showExamScheduleButton',
    'display.showUafTransfer',
    'display.showQuickTools',
    'display.showPasteButtons',
    'display.forceDesktopMode',
    'display.lateStudentsArePresent',
    'timeCard.enabled',
    'timeCard.use12h',
  ],
  hitokoto: ['hitokoto.enabled', 'hitokoto.online', 'hitokoto.refreshInterval'],
  random: [
    'randomPicker.enabled',
    'randomPicker.animation',
    'randomPicker.defaultCount',
    'randomPicker.excludeAbsent',
    'randomPicker.excludeLate',
    'randomPicker.excludeExcluded',
    'randomPicker.mode',
    'randomPicker.minNumber',
    'randomPicker.maxNumber',
  ],
  background: ['background.enabled', 'background.url', 'background.blur', 'background.opacity'],
  server: ['server.provider', 'server.domain', 'server.siteKey', 'server.classNumber'],
}

interface SettingsPageProps {
  onBack: () => void
  openStudents: () => void
  openSubjects: () => void
  openExams: () => void
}

export function SettingsPage({ onBack, openStudents, openSubjects, openExams }: SettingsPageProps) {
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

  const renderList = (keys: string[]) => (
    <div className="v-list">
      {keys
        .filter((key) => SETTING_DEFS[key])
        .map((key, index) => (
          <div key={key}>
            {index > 0 && <hr className="v-divider" style={{ margin: '4px 0' }} />}
            <SettingItem settingKey={key} />
          </div>
        ))}
    </div>
  )

  return (
    <>
      <AppBar title="设置" back={{ label: '返回', onBack }} hideSettings />

      <div className="settings-page" style={{ paddingTop: 'var(--appbar-h)' }}>
        <div className="settings-layout">
          <nav className={`settings-drawer ${drawerOpen ? 'open' : ''}`}>
            <div className="v-list">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={`v-list-item ${active === tab.key ? 'v-list-item--active' : ''}`}
                  style={{ borderRadius: '0 24px 24px 0', width: '100%' }}
                  onClick={() => {
                    setActive(tab.key)
                    setDrawerOpen(false)
                  }}
                >
                  <Icon name={tab.icon} size={20} className="mr-4" />
                  <span className="v-list-item-title">{tab.title}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="settings-content">
            <button
              type="button"
              className="v-btn v-btn--variant-text settings-menu-btn"
              onClick={() => setDrawerOpen((open) => !open)}
            >
              <Icon name="menu" size={20} />
              设置分类
            </button>

            {active === 'home' && (
              <>
                <SettingsCard title="ClassworksLite" subtitle="适用于班级大屏的作业板" icon="sparkle">
                  <div className="v-card-text text-body-2">
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
                      <div>· 本版本：React 19 + Vite + 单函数 KV，新增 UAF 导入导出与环境噪音监测</div>
                      <div>· 数据兼容：沿用 <code>classworks-data-YYYYMMDD</code> 等键名，可直接读取上游数据</div>
                      <div>· 项目说明与部署方式见仓库根目录的 README.md 与 NOTICE.md</div>
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard title="二次开发说明" icon="settings">
                  <div className="v-card-text text-body-2">
                    <p className="mb-3">
                      ClassworksLite 以二次开发为目标组织代码，修改时按下面的入口定位：
                    </p>
                    <div className="d-flex flex-column" style={{ gap: 6 }}>
                      <div>· 页面与组件：<code>src/pages</code>、<code>src/components</code></div>
                      <div>· 设置项：<code>src/lib/settings.ts</code>（键名、默认值、分组、标题）</div>
                      <div>· 主题与组件样式：<code>src/index.css</code>（<code>--v-theme-*</code> 令牌）</div>
                      <div>· 数据与同步：<code>src/lib/store.ts</code>、<code>src/lib/kv.ts</code></div>
                      <div>· 服务端：<code>server/kv-core.ts</code> 与 <code>functions</code> / <code>worker</code> / <code>api</code> 适配器</div>
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
                        <Icon name="external" size={16} />
                      </a>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal">AGPL-3.0</span>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal">React 19</span>
                      <span className="v-chip v-chip--size-small v-chip--variant-tonal">Serverless KV</span>
                    </div>
                  </div>
                </SettingsCard>

                <SettingsCard title="使用提示" icon="info">
                  <div className="v-card-text">
                    <div className="v-alert v-alert--variant-tonal rounded-xl" data-color="info">
                      <Icon name="info" size={20} />
                      <div>
                        请不要使用浏览器清除缓存功能，否则会导致配置丢失。
                        <del>恶意的操作可能导致您受到贵校教师的处理</del>
                      </div>
                    </div>
                    <div className="v-alert v-alert--variant-tonal rounded-xl mt-4" data-color="warning">
                      <Icon name="info" size={20} />
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
                          <Icon name="external" size={16} />
                        </a>
                      </div>
                    </div>
                  </div>
                </SettingsCard>
              </>
            )}

            {active === 'server' && (
              <>
                <SettingsCard title="连接状态" icon="cloud" subtitle="云端模式会把作业数据写入部署好的 /api/kv 接口">
                  <div className="v-card-text">
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
                          await store.reinitialize()
                          toast.success('已重新连接', '配置已生效')
                        }}
                      >
                        <Icon name="refresh" size={16} />
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
                  </div>
                </SettingsCard>

                <SettingsCard title="服务器" icon="server" className="mt-4">
                  {renderList(GROUP_SETTINGS.server ?? [])}
                </SettingsCard>
              </>
            )}

            {active === 'subject' && (
              <SettingsCard
                title="科目"
                icon="book"
                action={
                  <button type="button" className="v-btn v-btn--size-small v-btn--variant-tonal" data-color="primary" onClick={openSubjects}>
                    管理科目
                  </button>
                }
              >
                <div className="v-card-text">
                  <div className="d-flex flex-wrap" style={{ gap: 8 }}>
                    {state.subjects.map((subject) => (
                      <span key={subject.name} className="v-chip v-chip--variant-tonal" data-color="primary">
                        {subject.name}
                      </span>
                    ))}
                  </div>
                  <div className="d-flex flex-wrap mt-4" style={{ gap: 8 }}>
                    <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={openSubjects}>
                      <Icon name="edit" size={16} />
                      科目管理
                    </button>
                    <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={openExams}>
                      <Icon name="calendar" size={16} />
                      考试看板
                    </button>
                  </div>
                </div>
              </SettingsCard>
            )}

            {active === 'roster' && (
              <SettingsCard
                title="花名册"
                icon="users"
                action={
                  <button type="button" className="v-btn v-btn--size-small v-btn--variant-tonal" data-color="primary" onClick={openStudents}>
                    管理名单
                  </button>
                }
              >
                <div className="v-card-text">
                  <div className="text-body-2 mb-2">共 {state.students.length} 人</div>
                  <div className="d-flex flex-wrap" style={{ gap: 6 }}>
                    {state.students.map((name) => (
                      <span key={name} className="v-chip v-chip--size-small v-chip--variant-tonal">
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              </SettingsCard>
            )}

            {active === 'noise' && <NoiseSettingsCard />}

            {active === 'developer' && (
              <>
                <SettingsCard title="开发者选项" icon="settings">
                  <div className="v-list">
                    <SettingItem settingKey="developer.enabled" />
                  </div>
                </SettingsCard>
                {dev && (
                  <SettingsCard title="开发者设置" icon="testTube" className="mt-4">
                    <div className="v-list">
                      <SettingItem settingKey="developer.showTestCard" />
                    </div>
                  </SettingsCard>
                )}
                <SettingsCard title="危险操作" icon="warning" className="mt-4">
                  <div className="v-card-text d-flex flex-wrap" style={{ gap: 8 }}>
                    <button type="button" className="v-btn v-btn--size-small v-btn--variant-outlined" onClick={() => setResetOpen(true)}>
                      恢复默认设置
                    </button>
                    <button
                      type="button"
                      className="v-btn v-btn--size-small v-btn--variant-tonal"
                      data-color="error"
                      onClick={async () => {
                        await cacheClear()
                        toast.success('已清除本地缓存', '云端数据不受影响，刷新后会重新拉取')
                        window.setTimeout(() => window.location.reload(), 900)
                      }}
                    >
                      清除本地缓存
                    </button>
                  </div>
                </SettingsCard>
              </>
            )}

            {active !== 'home' &&
              active !== 'server' &&
              active !== 'subject' &&
              active !== 'roster' &&
              active !== 'noise' &&
              active !== 'developer' &&
              active !== 'about' &&
              GROUP_SETTINGS[active] && (
                <SettingsCard title={GROUP_LABELS[active as SettingGroup]} icon={TABS.find((tab) => tab.key === active)?.icon}>
                  {renderList(GROUP_SETTINGS[active] ?? [])}
                </SettingsCard>
              )}

            {active === 'about' && (
              <SettingsCard title="ClassworksLite" subtitle="适用于班级大屏的作业板" icon="sparkle">
                <div className="v-card-text text-body-2">
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
                      ['数据存储', provider === 'cloud' ? 'Serverless KV' : 'IndexedDB（本地）'],
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
        <p className="text-body-2">所有设置项将回到初始值，作业数据、学生名单与科目不会受影响。</p>
      </Modal>
    </>
  )
}

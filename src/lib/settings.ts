/**
 * 设置系统。
 *
 * 与 Classworks 的 SettingsManager 对齐：扁平点分键名 + 类型校验 + 默认值兜底，
 * 但改为「本地优先」：全部落在 localStorage，云同步只负责作业数据，
 * 这样设置项不依赖后端，Serverless 部署零配置即可用。
 */

const STORAGE_KEY = 'ClassworksLite_settings'
const CHANGE_EVENT = 'classworks-lite:settings'

export type SettingGroup =
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

export interface SettingDef {
  type: 'boolean' | 'number' | 'string'
  default: boolean | number | string
  /** 列表标题（与上游 settingsDefinitions.description 一致） */
  label: string
  hint?: string
  group: SettingGroup
  /** 仅开发者模式可见 */
  developer?: boolean
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  validate?: (value: string | number | boolean) => boolean
}

export const GROUP_LABELS: Record<SettingGroup, string> = {
  home: '首页',
  server: '服务器',
  subject: '科目',
  roster: '花名册',
  refresh: '刷新',
  edit: '编辑',
  display: '显示',
  noise: '噪音监测',
  hitokoto: '一言',
  random: '随机点名',
  background: '背景',
  developer: '开发者',
}

export const SETTING_DEFS: Record<string, SettingDef> = {
  /* ---------------- 主题 ---------------- */
  'theme.mode': {
    type: 'string',
    default: 'dark',
    label: '主题模式',
    group: 'display',
    options: [
      { value: 'dark', label: '深色' },
      { value: 'light', label: '浅色' },
    ],
  },
  'font.size': {
    type: 'number',
    default: 28,
    label: '字体大小',
    group: 'display',
    min: 16,
    max: 100,
    step: 1,
    unit: 'px',
  },

  /* ---------------- 显示 ---------------- */
  'display.emptySubjectDisplay': {
    type: 'string',
    default: 'card',
    label: '空科目的显示方式',
    group: 'display',
    options: [
      { value: 'card', label: '卡片' },
      { value: 'button', label: '按钮' },
    ],
  },
  'display.dynamicSort': {
    type: 'boolean',
    default: true,
    label: '是否启用动态排序',
    group: 'display',
  },
  'display.showRandomButton': {
    type: 'boolean',
    default: false,
    label: '是否显示随机点人按钮',
    group: 'display',
  },
  'display.showFullscreenButton': {
    type: 'boolean',
    default: true,
    label: '是否显示全屏按钮',
    group: 'display',
  },
  'display.cardHoverEffect': {
    type: 'boolean',
    default: true,
    label: '是否启用卡片悬浮效果',
    group: 'display',
  },
  'display.enhancedTouchMode': {
    type: 'boolean',
    default: true,
    label: '是否启用增强触摸模式',
    group: 'display',
  },
  'display.showAntiScreenBurnCard': {
    type: 'boolean',
    default: false,
    label: '是否显示防烧屏忽悠卡片',
    group: 'display',
  },
  'display.showListCard': {
    type: 'boolean',
    default: true,
    label: '是否显示列表卡片',
    group: 'display',
  },
  'display.showExamScheduleButton': {
    type: 'boolean',
    default: true,
    label: '是否显示考试看板',
    group: 'display',
  },
  'display.showUafTransfer': {
    type: 'boolean',
    default: true,
    label: '是否显示UAF作业导入导出',
    group: 'display',
  },
  'display.showQuickTools': {
    type: 'boolean',
    default: true,
    label: '是否显示快捷键盘',
    group: 'display',
  },
  'display.showPasteButtons': {
    type: 'boolean',
    default: true,
    label: '是否显示作业编辑粘贴按钮',
    group: 'display',
  },
  'display.forceDesktopMode': {
    type: 'boolean',
    default: false,
    label: '强制使用一体机UI模式',
    group: 'display',
  },
  'display.lateStudentsArePresent': {
    type: 'boolean',
    default: false,
    label: '将迟到人数算入出勤人数',
    group: 'display',
  },

  /* ---------------- 卡片 ---------------- */
  'timeCard.enabled': {
    type: 'boolean',
    default: true,
    label: '启用时间卡片',
    group: 'display',
  },
  'timeCard.use12h': {
    type: 'boolean',
    default: false,
    label: '使用 12 小时制显示时间',
    group: 'display',
  },
  'hitokoto.enabled': {
    type: 'boolean',
    default: true,
    label: '启用一言',
    group: 'hitokoto',
  },
  'hitokoto.online': {
    type: 'boolean',
    default: true,
    label: '从一言接口在线获取',
    group: 'hitokoto',
  },
  'hitokoto.refreshInterval': {
    type: 'number',
    default: 300,
    label: '刷新时间（秒，0为不自动刷新）',
    group: 'hitokoto',
    min: 0,
    max: 3600,
    step: 30,
    unit: '秒',
  },

  /* ---------------- 噪音监测 ---------------- */
  'noiseMonitor.enabled': {
    type: 'boolean',
    default: true,
    label: '启用环境噪音监测',
    group: 'noise',
  },
  'noiseMonitor.autoStart': {
    type: 'boolean',
    default: true,
    label: '打开页面时自动开始监测',
    group: 'noise',
  },
  'noiseMonitor.permissionDismissed': {
    type: 'boolean',
    default: false,
    label: '已跳过麦克风权限引导（不再弹出介绍弹框）',
    group: 'noise',
  },

  /* ---------------- 编辑 ---------------- */
  'edit.autoSave': {
    type: 'boolean',
    default: true,
    label: '是否启用自动保存',
    group: 'edit',
  },
  'edit.blockNonTodayAutoSave': {
    type: 'boolean',
    default: true,
    label: '禁止自动保存非当天数据',
    group: 'edit',
  },
  'edit.refreshBeforeEdit': {
    type: 'boolean',
    default: true,
    label: '编辑前是否自动刷新',
    group: 'edit',
  },
  'edit.confirmNonTodaySave': {
    type: 'boolean',
    default: true,
    label: '保存非当天数据需确认',
    group: 'edit',
  },
  'edit.blockPastDataEdit': {
    type: 'boolean',
    default: false,
    label: '禁止编辑过往数据',
    group: 'edit',
  },
  'edit.autoSavePromptText': {
    type: 'string',
    default: '喵？喵呜！',
    label: '自动保存模式提示文本',
    group: 'edit',
  },
  'edit.manualSavePromptText': {
    type: 'string',
    default: '写完后点击上传谢谢喵',
    label: '手动保存模式提示文本',
    group: 'edit',
  },
  'edit.canvasClickClose': {
    type: 'boolean',
    default: true,
    label: '点击空白处完成编辑',
    group: 'edit',
  },

  /* ---------------- 刷新 ---------------- */
  'refresh.auto': {
    type: 'boolean',
    default: false,
    label: '是否启用自动刷新',
    group: 'refresh',
  },
  'refresh.interval': {
    type: 'number',
    default: 300,
    label: '自动刷新间隔（秒）',
    group: 'refresh',
    min: 10,
    max: 3600,
    step: 10,
    unit: '秒',
  },
  'sync.realtime': {
    type: 'boolean',
    default: true,
    label: '自动拉取更新',
    group: 'refresh',
  },

  /* ---------------- 随机点名 ---------------- */
  'randomPicker.enabled': {
    type: 'boolean',
    default: true,
    label: '是否启用随机点名功能',
    group: 'random',
  },
  'randomPicker.animation': {
    type: 'boolean',
    default: true,
    label: '是否启用随机点名动画效果',
    group: 'random',
  },
  'randomPicker.defaultCount': {
    type: 'number',
    default: 1,
    label: '默认抽取人数',
    group: 'random',
    min: 1,
    max: 10,
  },
  'randomPicker.excludeAbsent': {
    type: 'boolean',
    default: true,
    label: '是否排除请假学生',
    group: 'random',
  },
  'randomPicker.excludeLate': {
    type: 'boolean',
    default: false,
    label: '是否排除迟到学生',
    group: 'random',
  },
  'randomPicker.excludeExcluded': {
    type: 'boolean',
    default: true,
    label: '是否排除不参与学生',
    group: 'random',
  },
  'randomPicker.mode': {
    type: 'string',
    default: 'name',
    label: '随机点名模式',
    group: 'random',
    options: [
      { value: 'name', label: '按姓名' },
      { value: 'number', label: '按学号' },
    ],
  },
  'randomPicker.minNumber': {
    type: 'number',
    default: 1,
    label: '学号模式最小值',
    group: 'random',
    min: 1,
    max: 100,
  },
  'randomPicker.maxNumber': {
    type: 'number',
    default: 60,
    label: '学号模式最大值',
    group: 'random',
    min: 1,
    max: 100,
  },

  /* ---------------- 服务器 ---------------- */
  'server.provider': {
    type: 'string',
    default: 'local',
    label: '数据提供者',
    group: 'server',
    options: [
      { value: 'local', label: '本地数据库' },
      { value: 'cloud', label: '服务器' },
    ],
  },
  'server.domain': {
    type: 'string',
    default: '',
    label: '后端服务器域名',
    group: 'server',
  },
  'server.siteKey': {
    type: 'string',
    default: '',
    label: '网站令牌',
    group: 'server',
  },
  'server.classNumber': {
    type: 'string',
    default: '高三八班',
    label: '班级编号',
    group: 'server',
  },

  /* ---------------- 背景 ---------------- */
  'background.enabled': {
    type: 'boolean',
    default: false,
    label: '启用自定义背景',
    group: 'background',
  },
  'background.url': {
    type: 'string',
    default: '',
    label: '背景图片地址',
    group: 'background',
  },
  'background.blur': {
    type: 'number',
    default: 10,
    label: '毛玻璃模糊幅度（px）',
    group: 'background',
    min: 0,
    max: 50,
    unit: 'px',
  },
  'background.opacity': {
    type: 'number',
    default: 30,
    label: '遮罩暗色程度（%）',
    group: 'background',
    min: 0,
    max: 80,
    unit: '%',
  },

  /* ---------------- 开发者 ---------------- */
  'developer.enabled': {
    type: 'boolean',
    default: false,
    label: '是否启用开发者选项',
    group: 'developer',
  },
  'developer.showTestCard': {
    type: 'boolean',
    default: true,
    label: '显示「添加测试卡片」按钮',
    group: 'developer',
    developer: true,
  },
}

type SettingsShape = Record<string, boolean | number | string>

function readStorage(): SettingsShape {
  const result: SettingsShape = {}
  for (const [key, def] of Object.entries(SETTING_DEFS)) result[key] = def.default

  if (typeof localStorage === 'undefined') return result
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return result
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [key, value] of Object.entries(parsed)) {
      const def = SETTING_DEFS[key]
      if (!def) continue
      if (typeof value !== def.type) continue
      if (def.validate && !def.validate(value as string | number | boolean)) continue
      result[key] = value as string | number | boolean
    }
  } catch (err) {
    console.warn('[settings] 读取失败，回退默认值', err)
  }
  return result
}

class SettingsStore {
  private state: SettingsShape = readStorage()
  private listeners = new Set<() => void>()

  get = <T extends boolean | number | string = string>(key: string): T => {
    return this.state[key] as T
  }

  getAll = (): SettingsShape => this.state

  set(key: string, value: boolean | number | string): boolean {
    const def = SETTING_DEFS[key]
    if (!def) {
      console.warn(`[settings] 未定义的设置项: ${key}`)
      return false
    }
    // 数值项按声明的 min/max 收敛，避免绕过输入框直接写入越界值（F10）
    if (typeof value === 'number' && Number.isFinite(value)) {
      const min = def.min ?? Number.NEGATIVE_INFINITY
      const max = def.max ?? Number.POSITIVE_INFINITY
      value = Math.min(max, Math.max(min, value))
    }
    if (def.validate && !def.validate(value)) {
      console.warn(`[settings] 非法取值: ${key}=${String(value)}`)
      return false
    }
    if (this.state[key] === value) return true

    this.state = { ...this.state, [key]: value }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch (err) {
      console.warn('[settings] 写入失败', err)
    }
    this.listeners.forEach((fn) => fn())
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value } }))
    }
    return true
  }

  reset(key: string) {
    const def = SETTING_DEFS[key]
    if (def) this.set(key, def.default)
  }

  resetAll() {
    const previous = this.state
    this.state = Object.fromEntries(
      Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.default]),
    ) as SettingsShape
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      /* ignore */
    }
    this.listeners.forEach((fn) => fn())
    // 逐个广播变更：数据客户端依赖 server.* 事件重建（F7）
    if (typeof window !== 'undefined') {
      for (const [key, value] of Object.entries(this.state)) {
        if (previous[key] === value) continue
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value } }))
      }
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** 跨标签页同步 */
  syncFromStorage = () => {
    this.state = readStorage()
    this.listeners.forEach((fn) => fn())
  }
}

export const settings = new SettingsStore()

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) settings.syncFromStorage()
  })
}

export const getSetting = settings.get
export const setSetting = (key: string, value: boolean | number | string) => settings.set(key, value)

/** 按分组返回可见设置项 */
export function settingsByGroup(group: SettingGroup): [string, SettingDef][] {
  const dev = settings.get<boolean>('developer.enabled')
  return Object.entries(SETTING_DEFS).filter(
    ([, def]) => def.group === group && (!def.developer || dev),
  )
}

/** 全局数据类型定义 */

export interface HomeworkItem {
  content: string
  /** 仅自定义卡片使用 */
  name?: string
  type?: 'homework' | 'custom' | 'exam'
  examId?: string
  tags?: string[]
}

export interface Attendance {
  absent: string[]
  late: string[]
  exclude: string[]
}

export interface BoardData {
  homework: Record<string, HomeworkItem>
  attendance: Attendance
}

export interface Subject {
  name: string
  order: number
}

export interface Student {
  name: string
}

export interface ExamSubjectEntry {
  name: string
  /** 考试日期 YYYY-MM-DD */
  date: string
  /** 开始时间 HH:mm */
  start?: string
  /** 结束时间 HH:mm */
  end?: string
  room?: string
}

export interface ExamConfig {
  id: string
  examName: string
  note?: string
  subjects: ExamSubjectEntry[]
  createdAt: number
  updatedAt: number
}

export interface HomeworkTemplate {
  version: 1
  subjects: Record<string, { books: Record<string, string[]> }>
  commonSubject?: { books: Record<string, string[]> }
  actions?: string[]
}

export type ProviderMode = 'local' | 'cloud'

export interface KVEntry<T = unknown> {
  value: T
  updatedAt: number
  /** 仅本地缓存使用：该条写入尚未同步到云端 */
  pending?: boolean
  /** 读取时命中本地缓存、未从网络取到最新值 */
  stale?: boolean
}

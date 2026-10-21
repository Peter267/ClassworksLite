/** 日期与时间工具。全部使用本地时区，避免跨时区漂移。 */

const pad = (n: number) => String(n).padStart(2, '0')

/** Date -> YYYYMMDD（作业板使用的 KV 键后缀格式） */
export function toDateKey(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/** Date -> YYYY-MM-DD */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** YYYYMMDD -> Date（本地时区零点） */
export function fromDateKey(key: string): Date {
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(4, 6))
  const d = Number(key.slice(6, 8))
  return new Date(y, m - 1, d)
}

export function today(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

export function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** 严格早于今天（未来日期不算历史） */
export function isPastDay(d: Date): boolean {
  return d.getTime() < today().getTime()
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

export function weekdayLabel(d: Date): string {
  return WEEKDAYS[d.getDay()]
}

/** 相对今天的自然语言描述 */
export function relativeDayLabel(d: Date): string {
  const t = today()
  const diff = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t.getTime()) / 86400000,
  )
  if (diff === 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === -2) return '前天'
  if (diff === 1) return '明天'
  if (diff === 2) return '后天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 2026年10月18日 */
export function longDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 10月18日 星期日 */
export function shortDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdayLabel(d)}`
}

export function periodOfDay(d: Date): string {
  const h = d.getHours()
  if (h < 6) return '凌晨'
  if (h < 8) return '早晨'
  if (h < 11) return '上午'
  if (h < 13) return '中午'
  if (h < 17) return '下午'
  if (h < 19) return '傍晚'
  if (h < 22) return '晚上'
  return '深夜'
}

/** 当日进度百分比，0-100 */
export function dayProgress(d: Date): number {
  const seconds = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
  return (seconds / 86400) * 100
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 日期 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 45_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} 天前`
  return toISODate(new Date(ts))
}

/** 校对宽松的日期输入（YYYYMMDD / YYYY-MM-DD） */
export function parseLooseDate(input: string): Date | null {
  const raw = input.trim()
  const compact = raw.replace(/[-/.]/g, '')
  if (!/^\d{8}$/.test(compact)) return null
  const y = Number(compact.slice(0, 4))
  const m = Number(compact.slice(4, 6))
  const d = Number(compact.slice(6, 8))
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

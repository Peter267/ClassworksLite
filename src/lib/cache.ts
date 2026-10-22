/**
 * 本机缓存层。
 *
 * 采用 localStorage 而不是 IndexedDB，原因：
 *  - 同步读写，首屏不依赖异步回调，弱网/隐私模式/无头环境下不会挂起；
 *  - 单个班级的数据量很小（每天几 KB），5MB 配额足够存放数年的历史；
 *  - 接口仍保持 Promise 形式，便于将来替换为 IndexedDB 或服务端缓存。
 *
 * 缓存只为加速与断网只读，不承担数据权威：所有改动都必须成功写入云端。
 */

const PREFIX = 'classworks-lite:kv:'

export interface RawRecord {
  key: string
  value: unknown
  updatedAt: number
  /** 该条已确认来自云端；旧版本机模式的遗留记录为 false */
  synced?: boolean
}

/** 本地存储不可写（配额耗尽或存储被禁用） */
export class StorageWriteError extends Error {
  constructor(message = '本机存储不可写') {
    super(message)
    this.name = 'StorageWriteError'
  }
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readAll(): RawRecord[] {
  const store = storage()
  if (!store) return []
  const records: RawRecord[] = []
  for (let i = 0; i < store.length; i += 1) {
    const name = store.key(i)
    if (!name?.startsWith(PREFIX)) continue
    try {
      const raw = store.getItem(name)
      if (!raw) continue
      const parsed = JSON.parse(raw) as RawRecord
      if (parsed && typeof parsed.key === 'string') records.push(parsed)
    } catch {
      /* 单条损坏不影响整体 */
    }
  }
  return records
}

export async function cacheAll(): Promise<RawRecord[]> {
  return readAll()
}

export async function cacheGet(key: string): Promise<RawRecord | undefined> {
  const store = storage()
  if (!store) return undefined
  try {
    const raw = store.getItem(PREFIX + key)
    if (!raw) return undefined
    return JSON.parse(raw) as RawRecord
  } catch {
    return undefined
  }
}

export async function cacheSet(record: RawRecord): Promise<void> {
  const store = storage()
  if (!store) throw new StorageWriteError('浏览器存储不可用，改动未能保存')

  const payload = JSON.stringify(record)
  try {
    store.setItem(PREFIX + record.key, payload)
    return
  } catch (err) {
    // 配额不足：只清理已同步的旧记录，刚写入的这条跳过
    console.warn('[cache] 写入失败，尝试清理已同步的旧记录', err)
    const reclaimable = readAll()
      .filter((item) => item.key !== record.key && item.synced !== false)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    for (const stale of reclaimable.slice(0, Math.max(1, Math.ceil(reclaimable.length / 3)))) {
      store.removeItem(PREFIX + stale.key)
    }
    try {
      store.setItem(PREFIX + record.key, payload)
    } catch {
      throw new StorageWriteError('设备存储空间不足，改动未能保存')
    }
  }
}

export async function cacheDelete(key: string): Promise<void> {
  storage()?.removeItem(PREFIX + key)
}

/** 清空本机缓存（设置页「清除本机缓存」使用） */
export async function cacheClear(): Promise<void> {
  const store = storage()
  if (!store) return
  const names: string[] = []
  for (let i = 0; i < store.length; i += 1) {
    const name = store.key(i)
    if (name?.startsWith(PREFIX)) names.push(name)
  }
  names.forEach((name) => store.removeItem(name))
}


/** Cloudflare KV 绑定到 Backend 的适配，Pages Functions 与 Worker 共用。 */
import type { Backend } from './kv-core'

interface KVListResult {
  keys: { name: string }[]
  list_complete: boolean
  cursor?: string
}

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options: { prefix?: string; cursor?: string }): Promise<KVListResult>
}

export function createKVBackend(kv: KVNamespaceLike): Backend {
  return {
    read: (key) => kv.get(key),
    write: (key, raw) => kv.put(key, raw),
    remove: (key) => kv.delete(key),
    async scan(prefix) {
      const names: string[] = []
      let cursor: string | undefined
      do {
        const page = await kv.list({ prefix, cursor })
        names.push(...page.keys.map((item) => item.name))
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
      return names
    },
  }
}

/**
 * Cloudflare Workers 入口（静态资源 + KV API 一体部署）。
 *
 * wrangler.toml 里配置了 [assets]，静态资源由 ASSETS 绑定提供，
 * /api/* 交给同一个 KV 处理器。
 */
import { handleKV, healthResponse, type Backend } from '../server/kv-core'

interface KVListResult {
  keys: { name: string }[]
  list_complete: boolean
  cursor?: string
}

interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options: { prefix?: string; cursor?: string }): Promise<KVListResult>
}

interface Env {
  KV: KVNamespaceLike
  ASSETS: { fetch(request: Request): Promise<Response> }
  SITE_TOKEN?: string
  CORS_ORIGIN?: string
}

function createBackend(kv: KVNamespaceLike): Backend {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return healthResponse(env.CORS_ORIGIN ?? '*')
    }

    if (url.pathname === '/api/kv') {
      if (!env.KV) {
        return new Response(JSON.stringify({ error: 'kv_not_bound' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }
      return handleKV(request, createBackend(env.KV), {
        siteToken: env.SITE_TOKEN,
        corsOrigin: env.CORS_ORIGIN,
      })
    }

    return env.ASSETS.fetch(request)
  },
}

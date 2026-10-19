/**
 * Cloudflare Pages Function：/api/kv
 *
 * 部署步骤见 README：
 *  1. 在 Cloudflare 控制台创建 KV 命名空间
 *  2. Pages 项目 → 设置 → Functions → KV 命名空间绑定，变量名填 KV
 *  3. （可选）添加环境变量 SITE_TOKEN 启用鉴权
 *  4. 构建命令 npm run build，输出目录 dist
 */
import { handleKV, type Backend } from '../../server/kv-core'

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

export async function onRequest(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context
  const options = { siteToken: env.SITE_TOKEN, corsOrigin: env.CORS_ORIGIN }

  if (!env.KV) {
    return new Response(
      JSON.stringify({ error: 'kv_not_bound', message: '未绑定 KV 命名空间，请检查 Pages 配置' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }

  return handleKV(request, createBackend(env.KV), options)
}

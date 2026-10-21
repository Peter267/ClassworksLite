/**
 * Cloudflare Pages Function：/api/kv
 *
 * 部署步骤见 README：
 *  1. 在 Cloudflare 控制台创建 KV 命名空间
 *  2. Pages 项目 → 设置 → Functions → KV 命名空间绑定，变量名填 KV
 *  3. （可选）添加环境变量 SITE_TOKEN 启用鉴权
 *  4. 构建命令 npm run build，输出目录 dist
 */
import { createKVBackend, type KVNamespaceLike } from '../../server/cloudflare'
import { handleKV } from '../../server/kv-core'

interface Env {
  KV: KVNamespaceLike
  SITE_TOKEN?: string
  CORS_ORIGIN?: string
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

  return handleKV(request, createKVBackend(env.KV), options)
}

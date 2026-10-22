/**
 * Cloudflare Pages Function：/api/admin
 *
 * 需要与 /api/kv 相同的 KV 绑定，并额外配置：
 *   ADMIN_PASSWORD  管理后台密码（必填，未配置时后台禁用）
 *   ADMIN_SECRET    可选，令牌签名密钥
 *   CORS_ORIGIN     可选，限制允许的跨域来源（站点自身固定同源调用）
 */
import { handleAdmin } from '../../server/admin-core'
import { createKVBackend, type KVNamespaceLike } from '../../server/cloudflare'

interface Env {
  KV: KVNamespaceLike
  ADMIN_PASSWORD?: string
  ADMIN_SECRET?: string
  CORS_ORIGIN?: string
}

export async function onRequest(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context

  if (!env.KV) {
    return new Response(
      JSON.stringify({ error: 'kv_not_bound', message: '服务暂不可用，请联系管理员' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }

  return handleAdmin(request, createKVBackend(env.KV), {
    password: env.ADMIN_PASSWORD,
    secret: env.ADMIN_SECRET,
    corsOrigin: env.CORS_ORIGIN,
  })
}

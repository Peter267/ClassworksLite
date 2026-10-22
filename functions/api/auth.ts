/**
 * Cloudflare Pages Function：/api/auth
 *
 * 环境变量：
 *   SITE_PASSWORD  只读密码（配置后查看作业需要先登录）
 *   EDIT_PASSWORD  可写密码（同一输入框输入后获得查看与修改权限）
 *   AUTH_SECRET    可选，访问令牌签名密钥；留空时由两个密码派生
 *   CORS_ORIGIN    可选，限制允许的跨域来源（站点自身固定同源调用）
 */
import { handleAccess } from '../../server/auth-core'
import { createKVBackend, type KVNamespaceLike } from '../../server/cloudflare'

interface Env {
  KV: KVNamespaceLike
  SITE_PASSWORD?: string
  EDIT_PASSWORD?: string
  AUTH_SECRET?: string
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

  return handleAccess(request, createKVBackend(env.KV), {
    viewPassword: env.SITE_PASSWORD,
    editPassword: env.EDIT_PASSWORD,
    secret: env.AUTH_SECRET,
    corsOrigin: env.CORS_ORIGIN,
  })
}

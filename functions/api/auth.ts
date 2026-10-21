/**
 * Cloudflare Pages Function：/api/auth
 *
 * 环境变量：
 *   SITE_PASSWORD  访问密码（配置后读取作业需要先登录）
 *   EDIT_TOKEN     编辑令牌（配置后写入 / 删除需要 X-Edit-Token）
 *   AUTH_SECRET    可选，访问令牌签名密钥；留空时使用 SITE_PASSWORD
 *   SITE_TOKEN     可选，旧版静态访问令牌，迁移期仍可使用
 *   CORS_ORIGIN    可选，前端与 Functions 不同源时填写前端来源
 */
import { handleAccess } from '../../server/auth-core'
import { createKVBackend, type KVNamespaceLike } from '../../server/cloudflare'

interface Env {
  KV: KVNamespaceLike
  SITE_PASSWORD?: string
  EDIT_TOKEN?: string
  AUTH_SECRET?: string
  SITE_TOKEN?: string
  CORS_ORIGIN?: string
}

export async function onRequest(context: {
  request: Request
  env: Env
}): Promise<Response> {
  const { request, env } = context

  if (!env.KV) {
    return new Response(
      JSON.stringify({ error: 'kv_not_bound', message: '未绑定 KV 命名空间，请检查 Pages 配置' }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }

  return handleAccess(request, createKVBackend(env.KV), {
    sitePassword: env.SITE_PASSWORD,
    editToken: env.EDIT_TOKEN,
    siteToken: env.SITE_TOKEN,
    secret: env.AUTH_SECRET,
    corsOrigin: env.CORS_ORIGIN,
  })
}

/**
 * Vercel Edge Function：/api/auth
 *
 * 与 /api/kv 共用 Upstash Redis，并读取：
 *   SITE_PASSWORD  只读密码（配置后查看作业需要先登录）
 *   EDIT_PASSWORD  可写密码（同一输入框输入后获得查看与修改权限）
 *   AUTH_SECRET    可选，访问令牌签名密钥；留空时由两个密码派生
 *   CORS_ORIGIN    可选，限制允许的跨域来源（站点自身固定同源调用）
 */
import { handleAccess } from '../server/auth-core'
import { UpstashBackend } from '../server/upstash'

export const config = { runtime: 'edge' }

export default async function handler(request: Request): Promise<Response> {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!url || !token) {
    return new Response(
      JSON.stringify({
        error: 'not_configured',
        message: '缺少 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 环境变量',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    )
  }

  return handleAccess(request, new UpstashBackend(url, token), {
    viewPassword: process.env.SITE_PASSWORD,
    editPassword: process.env.EDIT_PASSWORD,
    secret: process.env.AUTH_SECRET,
    corsOrigin: process.env.CORS_ORIGIN,
  })
}

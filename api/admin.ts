/**
 * Vercel Edge Function：/api/admin
 *
 * 与 /api/kv 共用 Upstash Redis，并额外读取：
 *   ADMIN_PASSWORD  管理后台密码（必填，未配置时后台禁用）
 *   ADMIN_SECRET    可选，令牌签名密钥
 *   CORS_ORIGIN     可选，前端与 API 不同源时填写前端来源
 */
import { handleAdmin } from '../server/admin-core'
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

  return handleAdmin(request, new UpstashBackend(url, token), {
    password: process.env.ADMIN_PASSWORD,
    secret: process.env.ADMIN_SECRET,
    corsOrigin: process.env.CORS_ORIGIN,
  })
}

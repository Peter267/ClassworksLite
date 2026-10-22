/**
 * Vercel Edge Function：/api/kv
 *
 * 需要两个环境变量（Upstash Redis 免费版即可）：
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * 可选：
 *   SITE_PASSWORD  只读密码
 *   EDIT_PASSWORD  可写密码
 *   CORS_ORIGIN    允许的来源，默认 *
 */
import { handleKV } from '../server/kv-core'
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

  return handleKV(request, new UpstashBackend(url, token), {
    viewPassword: process.env.SITE_PASSWORD,
    editPassword: process.env.EDIT_PASSWORD,
    authSecret: process.env.AUTH_SECRET,
    corsOrigin: process.env.CORS_ORIGIN,
  })
}

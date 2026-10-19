/**
 * Vercel Edge Function：/api/kv
 *
 * 需要两个环境变量（Upstash Redis 免费版即可）：
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * 可选：
 *   SITE_TOKEN     启用访问令牌
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
    siteToken: process.env.SITE_TOKEN,
    corsOrigin: process.env.CORS_ORIGIN,
  })
}

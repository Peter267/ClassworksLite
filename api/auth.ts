/**
 * Vercel Edge Function：/api/auth
 *
 * 与 /api/kv 共用 Upstash Redis，并读取：
 *   SITE_PASSWORD  访问密码（配置后读取作业需要先登录）
 *   EDIT_TOKEN     编辑令牌（配置后写入 / 删除需要 X-Edit-Token）
 *   AUTH_SECRET    可选，访问令牌签名密钥；留空时使用 SITE_PASSWORD
 *   SITE_TOKEN     可选，旧版静态访问令牌
 *   CORS_ORIGIN    可选，前端与 API 不同源时填写前端来源
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
    sitePassword: process.env.SITE_PASSWORD,
    editToken: process.env.EDIT_TOKEN,
    siteToken: process.env.SITE_TOKEN,
    secret: process.env.AUTH_SECRET,
    corsOrigin: process.env.CORS_ORIGIN,
  })
}

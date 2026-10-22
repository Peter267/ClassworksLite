/**
 * Cloudflare Workers 入口（静态资源 + KV API 一体部署）。
 *
 * wrangler.toml 里配置了 [assets]，静态资源由 ASSETS 绑定提供，
 * /api/* 交给同一个 KV 处理器。
 */
import { handleAdmin } from '../server/admin-core'
import { handleAccess } from '../server/auth-core'
import { createKVBackend, type KVNamespaceLike } from '../server/cloudflare'
import { handleKV, healthResponse } from '../server/kv-core'

interface Env {
  KV: KVNamespaceLike
  ASSETS: { fetch(request: Request): Promise<Response> }
  SITE_PASSWORD?: string
  EDIT_PASSWORD?: string
  AUTH_SECRET?: string
  ADMIN_PASSWORD?: string
  ADMIN_SECRET?: string
  CORS_ORIGIN?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') {
      return healthResponse(env.CORS_ORIGIN ?? '*')
    }

    if (
      url.pathname === '/api/kv' ||
      url.pathname === '/api/admin' ||
      url.pathname === '/api/auth'
    ) {
      if (!env.KV) {
        return new Response(JSON.stringify({ error: 'kv_not_bound' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        })
      }
      const backend = createKVBackend(env.KV)
      if (url.pathname === '/api/auth') {
        return handleAccess(request, backend, {
          viewPassword: env.SITE_PASSWORD,
          editPassword: env.EDIT_PASSWORD,
          secret: env.AUTH_SECRET,
          corsOrigin: env.CORS_ORIGIN,
        })
      }
      if (url.pathname === '/api/admin') {
        return handleAdmin(request, backend, {
          password: env.ADMIN_PASSWORD,
          secret: env.ADMIN_SECRET,
          corsOrigin: env.CORS_ORIGIN,
        })
      }
      return handleKV(request, backend, {
        viewPassword: env.SITE_PASSWORD,
        editPassword: env.EDIT_PASSWORD,
        authSecret: env.AUTH_SECRET,
        corsOrigin: env.CORS_ORIGIN,
      })
    }

    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'route_not_found' }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })
    }

    return env.ASSETS.fetch(request)
  },
}

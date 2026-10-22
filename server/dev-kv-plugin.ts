import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'
import { handleAdmin } from './admin-core'
import { handleAccess } from './auth-core'
import { handleKV, healthResponse, type Backend } from './kv-core'

/**
 * 本地开发用的 KV 接口：把 /api/kv、/api/auth 与 /api/admin 落到 .data/kv.json。
 *
 * 这样 `npm run dev` 就能完整走通云端读写、访问密码与管理后台，不必先部署后端。
 * 环境变量优先取 Vite 加载的 .env，其次取进程环境。
 */
export function devKV(env: Record<string, string | undefined> = {}): Plugin {
  const file = path.resolve(process.cwd(), '.data/kv.json')
  const readEnv = (name: string) => env[name] || process.env[name]
  let cache: Record<string, string> | null = null
  let writing: Promise<void> = Promise.resolve()

  async function ensure() {
    if (cache) return cache
    try {
      cache = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>
    } catch {
      cache = {}
    }
    return cache
  }

  async function persist() {
    const snapshot = JSON.stringify(cache ?? {})
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, snapshot, 'utf8')
    })
    await writing
  }

  const backend: Backend = {
    async read(key) {
      const db = await ensure()
      return db[key] ?? null
    },
    async write(key, raw) {
      const db = await ensure()
      db[key] = raw
      await persist()
    },
    async remove(key) {
      const db = await ensure()
      delete db[key]
      await persist()
    },
    async scan(prefix) {
      const db = await ensure()
      return Object.keys(db).filter((key) => key.startsWith(prefix))
    },
  }

  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/api/')) {
        next()
        return
      }

      try {
        if (url.pathname === '/api/health') {
          const response = healthResponse()
          res.statusCode = response.status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(await response.text())
          return
        }

        if (
          url.pathname !== '/api/kv' &&
          url.pathname !== '/api/auth' &&
          url.pathname !== '/api/admin'
        ) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'not_found' }))
          return
        }

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks)

        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (value === undefined) continue
          headers.set(name, Array.isArray(value) ? value.join(',') : value)
        }
        // 本地开发也必须覆盖客户端可伪造的 X-Forwarded-For，否则限流可被绕过
        if (req.socket.remoteAddress) {
          headers.set('x-forwarded-for', req.socket.remoteAddress.replace(/^::ffff:/, ''))
          headers.delete('cf-connecting-ip')
          headers.delete('x-real-ip')
        }

        const method = (req.method ?? 'GET').toUpperCase()
        const request = new Request(url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' || raw.length === 0 ? undefined : raw,
        })

        const response =
          url.pathname === '/api/admin'
            ? await handleAdmin(request, backend, {
                password: readEnv('ADMIN_PASSWORD'),
                secret: readEnv('ADMIN_SECRET'),
                corsOrigin: readEnv('CORS_ORIGIN'),
              })
            : url.pathname === '/api/auth'
              ? await handleAccess(request, backend, {
                  viewPassword: readEnv('SITE_PASSWORD'),
                  editPassword: readEnv('EDIT_PASSWORD'),
                  secret: readEnv('AUTH_SECRET'),
                  corsOrigin: readEnv('CORS_ORIGIN'),
                })
              : await handleKV(request, backend, {
                  viewPassword: readEnv('SITE_PASSWORD'),
                  editPassword: readEnv('EDIT_PASSWORD'),
                  authSecret: readEnv('AUTH_SECRET'),
                  corsOrigin: readEnv('CORS_ORIGIN'),
                })

        res.statusCode = response.status
        response.headers.forEach((value, name) => res.setHeader(name, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (err) {
        console.error('[dev-kv] 处理失败', err)
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    })()
  }

  return {
    name: 'classworks-lite:dev-kv',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

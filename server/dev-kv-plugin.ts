import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'
import { handleKV, healthResponse, type Backend } from './kv-core'

/**
 * 本地开发用的 KV 接口：把 /api/kv 落到 .data/kv.json。
 *
 * 这样 `npm run dev` 就能完整走通「云端模式」，不必先部署后端。
 */
export function devKV(): Plugin {
  const file = path.resolve(process.cwd(), '.data/kv.json')
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

        if (url.pathname !== '/api/kv') {
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

        const method = (req.method ?? 'GET').toUpperCase()
        const request = new Request(url, {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' || raw.length === 0 ? undefined : raw,
        })

        const response = await handleKV(request, backend, {
          siteToken: process.env.SITE_TOKEN,
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

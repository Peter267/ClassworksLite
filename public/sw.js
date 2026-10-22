/* ClassworksLite Service Worker
 * 策略：
 *  - 导航请求：network-first，失败回退到缓存的应用外壳（离线可用）
 *  - 静态资源：cache-first（构建产物带 hash，可长期缓存）
 *  - /api/：完全不缓存，保证数据一致性
 *  - 字体（含 MDI 图标字体）也缓存，保证离线时图标不缺失
 */

const VERSION = 'v5'
const CACHE_PREFIX = 'classworks-'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`
const ASSET_CACHE = `${CACHE_PREFIX}assets-${VERSION}`

const SCOPE = self.registration.scope
const scopedPath = (path) => new URL(path, SCOPE).pathname
const SHELL_URL = scopedPath('index.html')
const MANIFEST_URL = scopedPath('manifest.webmanifest')
const FAVICON_URL = scopedPath('favicon.svg')
const MDI_FONT_URL = scopedPath('fonts/mdi-subset.woff')
const ASSET_PREFIX = scopedPath('assets/')
const ICON_PREFIX = scopedPath('icons/')
const STATIC_PREFIXES = [
  ASSET_PREFIX,
  scopedPath('uaf/'),
  ICON_PREFIX,
  scopedPath('fonts/'),
]

function isStaticAsset(pathname) {
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/** 从 HTML 里提取同源的入口脚本/样式 */
function extractEntryAssets(html) {
  const urls = new Set()
  const pattern = /(?:src|href)="([^"]+)"/g
  let match = pattern.exec(html)
  while (match) {
    const value = match[1]
    if (value.startsWith(ASSET_PREFIX) || value.startsWith(ICON_PREFIX)) urls.add(value)
    pattern.lastIndex = match.index + match[0].length
    match = pattern.exec(html)
  }
  return [...urls]
}

const precached = new Set()

async function precacheAgainst(cache, urls) {
  await Promise.all(
    urls.map(async (url) => {
      if (precached.has(url)) return
      precached.add(url)
      try {
        const response = await fetch(url, { cache: 'reload' })
        if (response && response.ok) await cache.put(url, response)
      } catch {
        /* 单个资源失败不影响安装 */
        precached.delete(url)
      }
    }),
  )
}

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE)
  await precacheAgainst(cache, [SHELL_URL, MANIFEST_URL, FAVICON_URL])

  // 图标字体通过 CSS 引用，不会出现在 HTML 的 src/href 中，需要显式预缓存
  const assetCache = await caches.open(ASSET_CACHE)
  await precacheAgainst(assetCache, [MDI_FONT_URL])

  // 读取真实外壳，补上首屏 JS/CSS（构建产物文件名带 hash，只能从 HTML 里发现）
  try {
    const response = await fetch(SHELL_URL, { cache: 'reload' })
    if (!response || !response.ok) return
    const html = await response.clone().text()
    await cache.put(SHELL_URL, response)
    const entries = extractEntryAssets(html)
    if (entries.length > 0) {
      await precacheAgainst(assetCache, entries)
    }
  } catch {
    /* 离线安装时保持已有外壳缓存 */
  }
}

self.addEventListener('install', (event) => {
  // 不使用 skipWaiting：等待旧标签页关闭后再激活，避免旧页面动态加载的懒加载 chunk 失效
  event.waitUntil(precacheShell().catch(() => undefined))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) &&
                key !== SHELL_CACHE &&
                key !== ASSET_CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // 应用的数据接口固定在站点根 /api/（与 src/lib/kv.ts 一致）
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const contentType = response.headers.get('content-type') || ''
          if (response.ok && contentType.includes('text/html')) {
            const copy = response.clone()
            caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy)).catch(() => undefined)
            response
              .clone()
              .text()
              .then(async (html) => {
                const entries = extractEntryAssets(html)
                if (entries.length === 0) return
                const assetCache = await caches.open(ASSET_CACHE)
                await precacheAgainst(assetCache, entries)
              })
              .catch(() => undefined)
          }
          return response
        })
        .catch(async () => {
          const cached = await caches.match(SHELL_URL)
          return (
            cached ??
            new Response('<h1>离线</h1><p>请联网后重新打开作业板。</p>', {
              headers: { 'Content-Type': 'text/html; charset=utf-8' },
              status: 200,
            })
          )
        }),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok && isStaticAsset(url.pathname)) {
          const copy = response.clone()
          caches
            .open(ASSET_CACHE)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined)
        }
        return response
      })
    }),
  )
})

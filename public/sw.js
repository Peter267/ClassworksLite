/* ClassworksLite Service Worker
 * 策略：
 *  - 导航请求：network-first，失败回退到缓存的应用外壳（离线可用）
 *  - 静态资源：cache-first（构建产物带 hash，可长期缓存）；/uaf/ 字体与 wasm 同样入缓存
 *  - /api/：完全不缓存，保证数据一致性
 *
 * 首次安装时会读取应用外壳 HTML，把其中引用的 /assets/ 入口 JS/CSS 一并预缓存，
 * 这样「首次访问后断网重开」也能拿到完整资源。
 */

const VERSION = 'v2'
const SHELL_CACHE = `classworks-shell-${VERSION}`
const ASSET_CACHE = `classworks-assets-${VERSION}`
const SHELL_URL = '/index.html'
const STATIC_PREFIXES = ['/assets/', '/uaf/', '/icons/']

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
    if (value.startsWith('/assets/') || value.startsWith('/icons/')) urls.add(value)
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
  await cache.addAll([SHELL_URL, '/manifest.webmanifest', '/favicon.svg'])

  // 读取真实外壳，补上首屏 JS/CSS（构建产物文件名带 hash，只能从 HTML 里发现）
  try {
    const response = await fetch(SHELL_URL, { cache: 'reload' })
    if (!response || !response.ok) return
    const html = await response.clone().text()
    await cache.put(SHELL_URL, response)
    const entries = extractEntryAssets(html)
    if (entries.length > 0) {
      const assetCache = await caches.open(ASSET_CACHE)
      await precacheAgainst(assetCache, entries)
    }
  } catch {
    /* 离线安装时保持已有外壳缓存 */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheShell()
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
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
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy))
          // 首次上线访问时顺便补齐入口资源，降低后续离线重开缺资源的概率
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
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
    }),
  )
})

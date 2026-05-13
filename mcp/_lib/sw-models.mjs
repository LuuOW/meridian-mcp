// Reusable ServiceWorker snippet for the ask-meridian shared-origin model cache.
//
// Each app's sw.js does:
//
//   importScripts('/_lib/sw-models.mjs')   // classic SW
//     - or -
//   // module SW: import { installModelCache } from '/_lib/sw-models.mjs'
//
//   installModelCache()
//
// One CacheStorage entry ('meridian-models-v1') is shared by every app
// at the origin. The transformers.js fetches that resolve to huggingface.co
// or any cdn-lfs.huggingface.co host get pinned here on first download
// (tee'd in parallel — the model response stream is NOT awaited into the
// cache, otherwise the consumer would block on full-buffer).

const CACHE  = 'meridian-models-v1'
const HOSTS  = new Set([
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
])

export function installModelCache() {
  self.addEventListener('install', () => { self.skipWaiting() })

  // No mass-eviction on activate. We bump model versions per-slot via
  // edge-inference.mjs (IDB version pin → selective cache.delete). Wiping
  // the whole cache on a SW name bump trashes the user's multi-GB cache
  // for nothing.
  self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

  self.addEventListener('fetch', (event) => {
    let url
    try { url = new URL(event.request.url) } catch { return }
    if (!HOSTS.has(url.hostname)) return

    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(event.request)
      if (cached) return cached

      const response = await fetch(event.request)
      if (response && response.status === 200) {
        // Tee: one fork to caller, one fork to the cache. Awaiting the put
        // would buffer the entire 200+ MB body before the consumer saw a
        // byte — known v1 footgun. The waitUntil keeps the SW alive long
        // enough for the cache.put to finish in the background.
        event.waitUntil(cache.put(event.request, response.clone()))
      }
      return response
    })())
  })
}

// Convenience export so apps can probe / diagnose the cache.
export async function cachedSize() {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(CACHE)
    const keys = await cache.keys()
    let bytes = 0
    for (const k of keys) {
      const r = await cache.match(k)
      const len = parseInt(r?.headers?.get('content-length') || '0', 10)
      if (Number.isFinite(len)) bytes += len
    }
    return { entries: keys.length, bytes }
  } catch { return null }
}

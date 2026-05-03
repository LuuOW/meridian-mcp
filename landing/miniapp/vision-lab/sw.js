// Vision Lab service worker.
//
// Scope: /miniapp/vision-lab/. Caches the *shell* (HTML/CSS/JS) so the lab
// boots offline once visited. Does NOT cache:
//   - Camera frames (never leave the browser anyway).
//   - The VLM model weights — those live in OPFS, owned by transformers.js.
//   - /api/* responses — routing requires live LLM calls.
//   - HuggingFace CDN — handled by transformers.js's own caching.
//
// Strategy:
//   - HTML: network-first with a cache fallback (so refreshes pick up new
//     deploys, but going offline still works).
//   - Same-origin static assets (.css, .js, .svg, .webmanifest): stale-while-
//     revalidate (instant load, refreshed in background).
//   - Everything else: pass-through (default fetch).
//
// Versioning: bump CACHE_VERSION to invalidate the shell cache after a
// deploy that changes asset URLs. SWs auto-update on every navigation when
// the script byte-changes, so this is mainly for housekeeping.

const CACHE_VERSION = 'v1'
const SHELL_CACHE = `vision-lab-shell-${CACHE_VERSION}`

const SHELL_URLS = [
  '/miniapp/vision-lab/',
  '/miniapp/vision-lab/index.html',
  '/miniapp/vision-lab/lab.js',
  '/miniapp/vision-lab/lab.css',
  '/miniapp/vision-lab/manifest.webmanifest',
  '/miniapp/_md.js',
  '/miniapp/api.js',
  '/miniapp/mini-galaxy.js',
  '/miniapp/miniapp.css',
  '/miniapp/physics-panel.js',
  '/style.css',
  '/nav.js',
  '/favicon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache =>
      // addAll is atomic — if any URL 404s the install fails. Use
      // individual adds with allSettled so a single missing asset doesn't
      // block the whole install (common during local dev).
      Promise.allSettled(SHELL_URLS.map(u => cache.add(u)))
    ).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('vision-lab-shell-') && k !== SHELL_CACHE)
                     .map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Never touch non-GET, cross-origin, or /api/ requests.
  if (req.method !== 'GET') return
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  // HTML: network-first
  const isHTML = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')
  if (isHTML) {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone()
        caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {})
        return res
      }).catch(() => caches.match(req).then(r => r || caches.match('/miniapp/vision-lab/')))
    )
    return
  }

  // Same-origin static: stale-while-revalidate
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {})
        }
        return res
      }).catch(() => cached)
      return cached || network
    })
  )
})

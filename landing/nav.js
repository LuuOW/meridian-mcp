// Landing-page helpers. The new horizontal top-bar + Apps dropdown +
// ⌘K palette wiring lives inline in landing/_nav.html (synced into every
// nav-bearing surface by scripts/sync-nav.py) — that's the single source
// of truth.
//
// `initBurgerNav` used to wire the burger here; now it's a no-op stub
// kept only so existing `import { initBurgerNav } from '/nav.js'` calls
// don't break. Important: it must NOT stamp `btn.dataset.wired`, which
// would otherwise short-circuit the inline script and disable the new
// Apps dropdown / ⌘K behaviour.

export function initBurgerNav() {
  /* no-op — wiring lives in the synced inline <script> inside <nav> */
}

// Fetch the live npm version from /api/version and stamp it onto any
// matching elements. /api/version doesn't exist on GH Pages (no API),
// so we silently skip the fetch and just remove the loading attribute.
export function loadVersionBadge(...ids) {
  const host = location.host
  if (host === 'ask-meridian.uk' || host === 'www.ask-meridian.uk') {
    for (const id of ids) {
      const el = document.getElementById(id)
      if (el) el.removeAttribute('data-loading')
    }
    return
  }
  fetch('/api/version', { cache: 'default' })
    .then(r => r.ok ? r.json() : null)
    .then(d => {
      if (!d?.npm) return
      const v = d.npm
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        el.textContent = id === 'heroVersion' ? `MCP server · v${v}` : `MCP v${v}`
        el.removeAttribute('data-loading')
      }
    })
    .catch(() => {})
}

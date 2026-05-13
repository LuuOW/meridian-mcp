// Shared nav helpers — burger menu toggle + version badge fetcher.
// Used by landing/index.html, miniapp/app.js, vision-lab/lab.js so the
// behaviour stays consistent across all surfaces.

// Mark the nav link whose href matches the current page with
// class="current". Lets the (now identical) nav template stay
// page-agnostic while still highlighting where the user is.
export function markCurrentNavLink() {
  const here = location.pathname.replace(/\/index\.html$/, '/') || '/'
  document.querySelectorAll('#navMenu a').forEach(a => {
    const href = a.getAttribute('href')
    if (!href) return
    try {
      const u = new URL(href, location.href)
      if (u.host !== location.host) return
      const target = u.pathname.replace(/\/index\.html$/, '/') || '/'
      if (target === here) a.classList.add('current')
    } catch {}
  })
}

export function initBurgerNav() {
  const btn  = document.getElementById('burgerBtn')
  const menu = document.getElementById('navMenu')
  if (!btn || !menu) return
  // The synced <nav> template carries an inline script that wires the
  // same handlers and stamps data-wired. If it's already run, this
  // module-level call is a no-op so we don't double-bind (which would
  // cause every burger click to open-and-immediately-close).
  if (btn.dataset.wired) return
  btn.dataset.wired = '1'
  markCurrentNavLink()

  const toggle = (open) => {
    const isOpen = open !== undefined ? open : !menu.classList.contains('open')
    menu.classList.toggle('open', isOpen)
    btn.classList.toggle('open', isOpen)
    btn.setAttribute('aria-expanded', String(isOpen))
    if (isOpen) {
      const first = menu.querySelector('a')
      if (first) setTimeout(() => first.focus(), 50)
    } else {
      btn.focus()
    }
  }

  btn.addEventListener('click', e => { e.stopPropagation(); toggle() })
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggle(false)))
  document.addEventListener('click', e => {
    if (!menu.classList.contains('open')) return
    if (!menu.contains(e.target) && !btn.contains(e.target)) toggle(false)
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false) })
}

// Fetch the live npm version from /api/version and stamp it onto any
// matching elements. /api/version doesn't exist on GH Pages (no API),
// so we silently 404 in dev and only attempt the fetch in environments
// where a backend might serve it. The data-loading attribute stays
// where it is — the eyebrow text already reads `MCP server · vN.N.N`
// statically, so a missing version just leaves the static version.
export function loadVersionBadge(...ids) {
  // GH Pages: no backend, no /api/*. Skip the fetch to avoid the
  // cosmetic 404 in the console.
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

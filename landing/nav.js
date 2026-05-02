// Shared nav helpers — burger menu toggle + version badge fetcher.
// Used by landing/index.html, miniapp/app.js, vision-lab/lab.js so the
// behaviour stays consistent across all surfaces.

export function initBurgerNav() {
  const btn  = document.getElementById('burgerBtn')
  const menu = document.getElementById('navMenu')
  if (!btn || !menu) return

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
// matching elements. Pass element ids — typically heroVersion, versionBadge.
export function loadVersionBadge(...ids) {
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

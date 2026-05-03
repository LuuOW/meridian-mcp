// Landing-page only enhancements. Stays out of nav.js because none of these
// behaviours are shared with the miniapp / vision-lab.
//
// All effects respect `prefers-reduced-motion: reduce` and degrade to "do
// nothing" rather than "broken state" if a primitive (clipboard, View
// Transitions) isn't available.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

// ── Magnetic buttons ────────────────────────────────────────────────────────
// When the cursor enters a soft radius around any [data-magnetic] element,
// translate it a fraction of the cursor's offset. Disengages cleanly past the
// radius, throttled via rAF so it stays cheap during fast pointer moves.
export function initMagnetic() {
  if (reduceMotion) return
  const els = document.querySelectorAll('[data-magnetic]')
  if (!els.length) return

  const RANGE    = 110   // px beyond the button bbox where pull starts
  const STRENGTH = 0.22  // fraction of cursor delta the button moves

  let raf = 0
  let lastEvt = null

  const apply = () => {
    raf = 0
    if (!lastEvt) return
    for (const el of els) {
      const r  = el.getBoundingClientRect()
      const cx = r.left + r.width  / 2
      const cy = r.top  + r.height / 2
      const dx = lastEvt.clientX - cx
      const dy = lastEvt.clientY - cy
      const reach = RANGE + Math.max(r.width, r.height) / 2
      if (Math.hypot(dx, dy) > reach) {
        if (el.style.translate) el.style.translate = ''
      } else {
        el.style.translate = `${(dx * STRENGTH).toFixed(1)}px ${(dy * STRENGTH).toFixed(1)}px`
      }
    }
  }

  document.addEventListener('mousemove', (e) => {
    lastEvt = e
    if (!raf) raf = requestAnimationFrame(apply)
  }, { passive: true })

  // Drop translation on leave so a button never gets stuck off-axis
  document.addEventListener('mouseleave', () => {
    for (const el of els) el.style.translate = ''
  })
}

// ── Click-to-copy on hero snippet ───────────────────────────────────────────
export function initCopySnippet() {
  for (const pre of document.querySelectorAll('pre.hero-snippet')) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'snippet-copy'
    btn.setAttribute('aria-label', 'Copy install snippet')
    btn.innerHTML = '<span class="snippet-copy-label">Copy</span>'
    pre.appendChild(btn)

    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent || ''
      const label = btn.querySelector('.snippet-copy-label')
      try {
        await navigator.clipboard.writeText(code)
        label.textContent = 'Copied ✓'
        btn.classList.add('copied')
      } catch {
        label.textContent = 'Failed'
        btn.classList.add('failed')
      }
      setTimeout(() => {
        label.textContent = 'Copy'
        btn.classList.remove('copied', 'failed')
      }, 1800)
    })
  }
}

// ── Cursor-aware hero halo ─────────────────────────────────────────────────
// Drives a CSS custom property `--cursor-x/y` on the hero element so a
// gradient layer can track the pointer. Adds depth without a heavy parallax
// library. Pure CSS handles the actual paint via the layer in style.css.
export function initHeroCursor() {
  if (reduceMotion) return
  const hero = document.querySelector('.hero')
  if (!hero) return

  let raf = 0
  let lastEvt = null

  const apply = () => {
    raf = 0
    if (!lastEvt) return
    const r = hero.getBoundingClientRect()
    const x = ((lastEvt.clientX - r.left) / r.width)  * 100
    const y = ((lastEvt.clientY - r.top)  / r.height) * 100
    hero.style.setProperty('--cursor-x', `${x.toFixed(1)}%`)
    hero.style.setProperty('--cursor-y', `${y.toFixed(1)}%`)
  }

  hero.addEventListener('mousemove', (e) => {
    lastEvt = e
    if (!raf) raf = requestAnimationFrame(apply)
  }, { passive: true })

  hero.addEventListener('mouseleave', () => {
    hero.style.removeProperty('--cursor-x')
    hero.style.removeProperty('--cursor-y')
  })
}

// ── View Transitions for in-site nav ───────────────────────────────────────
// Cross-document view transitions are gated by @view-transition in CSS, but
// some browsers honour an explicit hint here too. No-op when unsupported.
export function initViewTransitions() {
  if (!('startViewTransition' in document)) return
  // Same-origin clicks already pick up @view-transition rules; nothing else
  // to wire here. Function exists so callers can opt in explicitly later.
}

// mini-galaxy.js — small inline canvas above results.
// Two modes: 2D (top-down orbital plane) and 3D (tilted perspective).
// Persistent starfield + skill planets seeded from the latest /api/route response.
// Visual language adapted from the standalone galaxy viz at galaxy.ask-meridian.uk.

const RING_COLORS = [
  { ring: 'rgba(167, 139, 250, 0.55)', planet: '#c4b5fd', glow: 'rgba(167, 139, 250, 0.45)' }, // violet
  { ring: 'rgba(56, 189, 248, 0.55)',  planet: '#7dd3fc', glow: 'rgba(56, 189, 248, 0.45)'  }, // cyan
  { ring: 'rgba(16, 185, 129, 0.55)',  planet: '#6ee7b7', glow: 'rgba(16, 185, 129, 0.45)'  }, // mint
  { ring: 'rgba(244, 114, 182, 0.55)', planet: '#f9a8d4', glow: 'rgba(244, 114, 182, 0.45)' }, // pink
  { ring: 'rgba(251, 191, 36, 0.55)',  planet: '#fcd34d', glow: 'rgba(251, 191, 36, 0.45)'  }, // amber
  { ring: 'rgba(148, 163, 184, 0.45)', planet: '#cbd5e1', glow: 'rgba(148, 163, 184, 0.35)' }, // slate
  { ring: 'rgba(192, 132, 252, 0.55)', planet: '#d8b4fe', glow: 'rgba(192, 132, 252, 0.45)' }, // purple
]

export class MiniGalaxy {
  constructor(canvas, { mode = '2d', onPlanetClick } = {}) {
    this.canvas = canvas
    this.ctx    = canvas.getContext('2d')
    this.mode   = mode                       // '2d' or '3d'
    this.onPlanetClick = onPlanetClick || (() => {})
    this.t      = 0                          // animation time
    this.dpr    = Math.min(2, window.devicePixelRatio || 1)
    this.planets = []                        // { slug, score, color, orbit, phase, baseSize }
    this.stars   = this._makeStars(220)
    this.hover   = null
    this.lastFrame = 0

    this._onResize = this._resize.bind(this)
    window.addEventListener('resize', this._onResize, { passive: true })

    // The canvas may be inside a hidden section at construction time
    // (display:none → getBoundingClientRect returns 0×0). Watch for the
    // first non-zero size and re-resize then.
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize())
      this._ro.observe(canvas)
    }

    canvas.addEventListener('mousemove', e => this._onPointerMove(e))
    canvas.addEventListener('mouseleave', () => { this.hover = null; canvas.style.cursor = 'default' })
    canvas.addEventListener('click',     e => this._onPointerClick(e))
    canvas.addEventListener('touchstart', e => {
      const t = e.touches[0]
      if (!t) return
      this._onPointerMove(t)
      this._onPointerClick(t)
    }, { passive: true })

    this._resize()
    this._loop = this._loop.bind(this)
    requestAnimationFrame(this._loop)
  }

  destroy() {
    window.removeEventListener('resize', this._onResize)
    if (this._ro) this._ro.disconnect()
    this._stopped = true
  }

  setMode(mode) {
    if (mode === '2d' || mode === '3d') this.mode = mode
  }

  setSkills(ranked) {
    // Build new planets, preserving phase if a slug is still present (no jump).
    const prev = new Map(this.planets.map(p => [p.slug, p]))
    const N    = Math.min(ranked.length, 7)
    this.planets = ranked.slice(0, N).map((r, i) => {
      const c = RING_COLORS[i % RING_COLORS.length]
      const old = prev.get(r.slug)
      return {
        slug:     r.slug,
        score:    r.route_score,
        index:    i,
        color:    c,
        orbit:    1 + i * 0.55 + (i === 0 ? 0 : Math.random() * 0.05),
        phase:    old ? old.phase : (i * 0.9 + Math.random() * 0.6),
        speed:    0.18 - i * 0.018,        // outer planets orbit slower
        baseSize: Math.max(2.4, 6 - i * 0.45),
      }
    })
  }

  // ── Internal ────────────────────────────────────────────────────────────
  _makeStars(n) {
    return Array.from({ length: n }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + Math.random() * 1.4,
      tw: Math.random() * Math.PI * 2,
      hue: Math.random() < 0.18 ? 'cyan' : (Math.random() < 0.4 ? 'violet' : 'white'),
    }))
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return   // hidden — defer
    this.w = rect.width
    this.h = rect.height
    this.canvas.width  = Math.round(rect.width  * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  _project(x, y, z) {
    // 2D mode: top-down (drop z).
    // 3D mode: tilt the orbital plane and apply weak perspective.
    if (this.mode === '2d') {
      return { x, y, z: 0, scale: 1 }
    }
    const TILT = 0.42                         // ~24°
    const yp   = y * Math.cos(TILT) - z * Math.sin(TILT)
    const zp   = y * Math.sin(TILT) + z * Math.cos(TILT)
    const persp = 1 / (1 + zp / 380)          // weak perspective
    return { x: x * persp, y: yp * persp, z: zp, scale: persp }
  }

  _onPointerMove(e) {
    const r = this.canvas.getBoundingClientRect()
    this._mx = e.clientX - r.left
    this._my = e.clientY - r.top
    const hit = this._hit(this._mx, this._my)
    this.hover = hit ? hit.slug : null
    this.canvas.style.cursor = hit ? 'pointer' : 'default'
  }

  _onPointerClick(e) {
    const r = this.canvas.getBoundingClientRect()
    const hit = this._hit(e.clientX - r.left, e.clientY - r.top)
    if (hit) this.onPlanetClick(hit.slug)
  }

  _hit(mx, my) {
    if (!this.planets.length) return null
    // Re-run projection to get current screen positions.
    const cx = this.w / 2, cy = this.h / 2
    const radiusUnit = Math.min(this.w, this.h * 2.4) * 0.13
    let best = null, bestDist = Infinity
    for (const p of this.planets) {
      const a = this.t * p.speed + p.phase
      const r = p.orbit * radiusUnit
      const x = Math.cos(a) * r
      const y = Math.sin(a) * r
      const proj = this._project(x, y, 0)
      const sx = cx + proj.x, sy = cy + proj.y
      const size = p.baseSize * proj.scale + 4
      const d = Math.hypot(mx - sx, my - sy)
      if (d <= size + 6 && d < bestDist) { best = p; bestDist = d }
    }
    return best
  }

  _loop(now) {
    if (this._stopped) return
    if (!this.lastFrame) this.lastFrame = now
    const dt = Math.min(0.06, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.t += dt

    this._draw()
    requestAnimationFrame(this._loop)
  }

  _draw() {
    const { ctx, w, h } = this
    if (!w || !h) return

    // Background gradient
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.85)
    grad.addColorStop(0,   'rgba(28, 22, 50, 1)')
    grad.addColorStop(0.5, 'rgba(12, 13, 30, 1)')
    grad.addColorStop(1,   'rgba(6, 8, 15, 1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    // Soft nebula tint
    const neb = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, Math.max(w, h) * 0.5)
    neb.addColorStop(0,   'rgba(167, 139, 250, 0.18)')
    neb.addColorStop(1,   'rgba(167, 139, 250, 0)')
    ctx.fillStyle = neb
    ctx.fillRect(0, 0, w, h)
    const neb2 = ctx.createRadialGradient(w * 0.2, h * 0.75, 0, w * 0.2, h * 0.75, Math.max(w, h) * 0.45)
    neb2.addColorStop(0, 'rgba(56, 189, 248, 0.12)')
    neb2.addColorStop(1, 'rgba(56, 189, 248, 0)')
    ctx.fillStyle = neb2
    ctx.fillRect(0, 0, w, h)

    // Stars (parallax: slow drift, twinkle)
    for (const s of this.stars) {
      const tw = (Math.sin(this.t * 1.4 + s.tw) + 1) * 0.5      // 0..1
      const alpha = 0.35 + tw * 0.6
      const px = ((s.x + this.t * 0.004) % 1) * w
      const py = s.y * h
      const tone = s.hue === 'violet' ? '167,139,250' : s.hue === 'cyan' ? '56,189,248' : '255,255,255'
      ctx.fillStyle = `rgba(${tone},${alpha})`
      ctx.beginPath()
      ctx.arc(px, py, s.r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Center star (the "Meridian" — common parent for all skills)
    const cx = w / 2, cy = h / 2
    const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22)
    sun.addColorStop(0,   'rgba(255, 224, 156, 1)')
    sun.addColorStop(0.4, 'rgba(252, 211, 77, 0.55)')
    sun.addColorStop(1,   'rgba(252, 211, 77, 0)')
    ctx.fillStyle = sun
    ctx.beginPath()
    ctx.arc(cx, cy, 22, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fef3c7'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.2, 0, Math.PI * 2)
    ctx.fill()

    if (!this.planets.length) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.45)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('// awaiting query', cx, cy + 56)
      return
    }

    const radiusUnit = Math.min(w, h * 2.4) * 0.13

    // Sort by depth so back planets render first in 3D mode
    const drawOrder = this.planets.map(p => {
      const a = this.t * p.speed + p.phase
      const x = Math.cos(a) * p.orbit * radiusUnit
      const y = Math.sin(a) * p.orbit * radiusUnit
      const proj = this._project(x, y, 0)
      return { p, a, proj }
    })
    if (this.mode === '3d') drawOrbit3D(ctx, cx, cy, this.planets, radiusUnit, this._project.bind(this))
    else                     drawOrbit2D(ctx, cx, cy, this.planets, radiusUnit)

    drawOrder.sort((a, b) => a.proj.z - b.proj.z)
    for (const { p, proj } of drawOrder) {
      const sx = cx + proj.x, sy = cy + proj.y
      const size = p.baseSize * proj.scale
      const isHover = this.hover === p.slug

      // Outer glow
      const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * (isHover ? 4.5 : 3))
      gl.addColorStop(0, p.color.glow)
      gl.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gl
      ctx.beginPath()
      ctx.arc(sx, sy, size * (isHover ? 4.5 : 3), 0, Math.PI * 2)
      ctx.fill()

      // Planet body
      ctx.fillStyle = p.color.planet
      ctx.beginPath()
      ctx.arc(sx, sy, size, 0, Math.PI * 2)
      ctx.fill()

      // Subtle rim highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth   = 0.6
      ctx.stroke()

      if (isHover) {
        ctx.fillStyle = 'rgba(230, 236, 245, 0.95)'
        ctx.font = '11px ui-monospace, monospace'
        ctx.textAlign = 'center'
        ctx.fillText(p.slug, sx, sy - size - 8)
      }
    }
  }
}

function drawOrbit2D(ctx, cx, cy, planets, radiusUnit) {
  for (const p of planets) {
    ctx.strokeStyle = p.color.ring
    ctx.lineWidth = 0.8
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.arc(cx, cy, p.orbit * radiusUnit, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

function drawOrbit3D(ctx, cx, cy, planets, radiusUnit, project) {
  for (const p of planets) {
    ctx.strokeStyle = p.color.ring
    ctx.lineWidth = 0.8
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    const STEPS = 96
    for (let i = 0; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2
      const x = Math.cos(a) * p.orbit * radiusUnit
      const y = Math.sin(a) * p.orbit * radiusUnit
      const pr = project(x, y, 0)
      const sx = cx + pr.x, sy = cy + pr.y
      if (i === 0) ctx.moveTo(sx, sy)
      else         ctx.lineTo(sx, sy)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }
}

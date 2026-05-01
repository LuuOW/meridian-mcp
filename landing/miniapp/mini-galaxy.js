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

// Camera defaults per mode
const CAM_2D = { tilt: 0,    rot: 0, zoom: 1 }
const CAM_3D = { tilt: 1.05, rot: 0, zoom: 1 }   // ~60° tilt — clearly different from 2D
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3.5

export class MiniGalaxy {
  constructor(canvas, { mode = '2d', onPlanetClick } = {}) {
    this.canvas = canvas
    this.ctx    = canvas.getContext('2d')
    this.mode   = mode
    this.onPlanetClick = onPlanetClick || (() => {})

    // Camera state — tilt around X axis, rot around Y axis, zoom is uniform.
    this.cam = { ...(mode === '3d' ? CAM_3D : CAM_2D) }

    this.t      = 0
    this.dpr    = Math.min(2, window.devicePixelRatio || 1)
    this.planets = []
    this.stars   = this._makeStars(220)
    this.hover   = null
    this.lastFrame = 0

    // Hint pill auto-fades after first interaction
    this.hintAlpha = mode === '3d' ? 1 : 0
    this._touched  = false

    // Pointer / gesture state
    this._dragging       = false
    this._dragMoved      = 0
    this._lastX = 0; this._lastY = 0
    this._pinchStartDist = 0
    this._pinchStartZoom = 1

    this._onResize = this._resize.bind(this)
    window.addEventListener('resize', this._onResize, { passive: true })

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._resize())
      this._ro.observe(canvas)
    }

    this._bindInput(canvas)

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
    if (mode !== '2d' && mode !== '3d') return
    if (mode === this.mode) return
    this.mode = mode
    // Reset camera to mode default but preserve user zoom — feels less jumpy.
    const z = this.cam.zoom
    this.cam = { ...(mode === '3d' ? CAM_3D : CAM_2D), zoom: z }
    if (mode === '3d') { this.hintAlpha = 1; this._touched = false }
    else                this.hintAlpha = 0
  }

  setSkills(ranked) {
    const prev = new Map(this.planets.map(p => [p.slug, p]))
    const N    = Math.min(ranked.length, 7)
    this.planets = ranked.slice(0, N).map((r, i) => {
      const c = RING_COLORS[i % RING_COLORS.length]
      const old = prev.get(r.slug)
      // Each planet gets a per-orbit inclination (radians) so in 3D mode
      // they don't all sit in the same plane — orbits cross visibly.
      const inc = old ? old.inclination
                : (i === 0 ? 0 : ((i % 2 === 0 ? 1 : -1) * (0.12 + ((i * 0.13) % 0.28))))
      return {
        slug:        r.slug,
        score:       r.route_score,
        index:       i,
        color:       c,
        orbit:       1 + i * 0.55 + (i === 0 ? 0 : (i % 3) * 0.04),
        phase:       old ? old.phase : (i * 0.9 + (i * 0.37) % 1),
        speed:       0.18 - i * 0.018,
        baseSize:    Math.max(2.4, 6 - i * 0.45),
        inclination: inc,
      }
    })
  }

  // ── INPUT ────────────────────────────────────────────────────────────────
  _bindInput(canvas) {
    canvas.addEventListener('mousemove', e => {
      if (this._dragging) {
        const dx = e.clientX - this._lastX
        const dy = e.clientY - this._lastY
        this._lastX = e.clientX; this._lastY = e.clientY
        this._dragMoved += Math.abs(dx) + Math.abs(dy)
        this._applyDrag(dx, dy)
      } else {
        this._updateHover(e.clientX, e.clientY)
      }
    })
    canvas.addEventListener('mouseleave', () => {
      this.hover = null; canvas.style.cursor = 'default'; this._dragging = false
    })
    canvas.addEventListener('mousedown', e => {
      this._dragging  = true
      this._dragMoved = 0
      this._lastX = e.clientX; this._lastY = e.clientY
      this._touched = true; this.hintAlpha = Math.min(this.hintAlpha, 0.001)  // start fade
      this._setGrabCursor()
    })
    window.addEventListener('mouseup', () => {
      this._dragging = false
      this.canvas.style.cursor = this.hover ? 'pointer' : 'default'
    })
    canvas.addEventListener('click', e => {
      // Suppress click if the user dragged (rotation), allow taps only.
      if (this._dragMoved > 6) return
      const r = this.canvas.getBoundingClientRect()
      const hit = this._hit(e.clientX - r.left, e.clientY - r.top)
      if (hit) this.onPlanetClick(hit.slug)
    })

    canvas.addEventListener('wheel', e => {
      e.preventDefault()
      this._touched = true; this.hintAlpha = Math.min(this.hintAlpha, 0.001)
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      this.cam.zoom = clamp(this.cam.zoom * factor, ZOOM_MIN, ZOOM_MAX)
    }, { passive: false })

    // Touch
    canvas.addEventListener('touchstart', e => {
      this._touched = true; this.hintAlpha = Math.min(this.hintAlpha, 0.001)
      if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1]
        this._pinchStartDist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY)
        this._pinchStartZoom = this.cam.zoom
        this._dragging = false
        e.preventDefault()
      } else if (e.touches.length === 1) {
        const t = e.touches[0]
        this._dragging  = true
        this._dragMoved = 0
        this._lastX = t.clientX; this._lastY = t.clientY
        this._updateHover(t.clientX, t.clientY)
      }
    }, { passive: false })

    canvas.addEventListener('touchmove', e => {
      if (e.touches.length === 2) {
        const t0 = e.touches[0], t1 = e.touches[1]
        const d = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY)
        if (this._pinchStartDist > 0) {
          this.cam.zoom = clamp(this._pinchStartZoom * d / this._pinchStartDist, ZOOM_MIN, ZOOM_MAX)
        }
        e.preventDefault()
      } else if (e.touches.length === 1 && this._dragging) {
        const t = e.touches[0]
        const dx = t.clientX - this._lastX
        const dy = t.clientY - this._lastY
        this._lastX = t.clientX; this._lastY = t.clientY
        this._dragMoved += Math.abs(dx) + Math.abs(dy)
        this._applyDrag(dx, dy)
        if (this._dragMoved > 6) e.preventDefault()    // claim gesture for rotate
      }
    }, { passive: false })

    canvas.addEventListener('touchend', e => {
      // Tap = touch ended with little movement and one finger involved.
      if (this._dragging && this._dragMoved <= 6) {
        const t = e.changedTouches[0]
        if (t) {
          const r = this.canvas.getBoundingClientRect()
          const hit = this._hit(t.clientX - r.left, t.clientY - r.top)
          if (hit) this.onPlanetClick(hit.slug)
        }
      }
      this._dragging = false
      this._pinchStartDist = 0
    }, { passive: true })

    canvas.addEventListener('touchcancel', () => {
      this._dragging = false; this._pinchStartDist = 0
    }, { passive: true })
  }

  _applyDrag(dx, dy) {
    if (this.mode === '3d') {
      this.cam.rot  += dx * 0.008
      this.cam.tilt  = clamp(this.cam.tilt + dy * 0.008, 0.05, 1.45)
    } else {
      // 2D: drag pans nothing — zoom only. Could pan here later if useful.
      // For now treat horizontal drag as zoom feedback (slight): no-op.
    }
  }

  _setGrabCursor() {
    if (this.mode === '3d') this.canvas.style.cursor = 'grabbing'
  }

  _updateHover(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect()
    const hit = this._hit(clientX - r.left, clientY - r.top)
    this.hover = hit ? hit.slug : null
    if (this._dragging) return
    this.canvas.style.cursor = hit ? 'pointer' : (this.mode === '3d' ? 'grab' : 'default')
  }

  // ── PROJECTION ──────────────────────────────────────────────────────────
  _resize() {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    this.w = rect.width
    this.h = rect.height
    this.canvas.width  = Math.round(rect.width  * this.dpr)
    this.canvas.height = Math.round(rect.height * this.dpr)
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  _project(x, y, z) {
    const z0 = this.cam.zoom
    if (this.mode === '2d') {
      return { x: x * z0, y: y * z0, z: 0, scale: z0 }
    }
    // Rotate around y axis (user "spin")
    const cosR = Math.cos(this.cam.rot),  sinR = Math.sin(this.cam.rot)
    const xr =  x * cosR + z * sinR
    const zr = -x * sinR + z * cosR
    // Tilt around x axis (user "look from above")
    const cosT = Math.cos(this.cam.tilt), sinT = Math.sin(this.cam.tilt)
    const yp = y * cosT - zr * sinT
    const zp = y * sinT + zr * cosT
    // Weak perspective — closer = bigger
    const persp = 1 / (1 + zp / 380)
    return {
      x: xr * persp * z0,
      y: yp * persp * z0,
      z: zp,
      scale: persp * z0,
    }
  }

  _hit(mx, my) {
    if (!this.planets.length) return null
    const cx = this.w / 2, cy = this.h / 2
    const radiusUnit = Math.min(this.w, this.h * 2.4) * 0.13
    let best = null, bestDist = Infinity
    for (const p of this.planets) {
      const a = this.t * p.speed + p.phase
      const r = p.orbit * radiusUnit
      const lx = Math.cos(a) * r
      const ly = Math.sin(a) * r
      // Tilted orbit (3D); flat in 2D
      let x = lx, y = ly, z = 0
      if (this.mode === '3d') {
        y = ly * Math.cos(p.inclination)
        z = ly * Math.sin(p.inclination)
      }
      const proj = this._project(x, y, z)
      const sx = cx + proj.x, sy = cy + proj.y
      const size = p.baseSize * proj.scale + 4
      const d = Math.hypot(mx - sx, my - sy)
      if (d <= size + 6 && d < bestDist) { best = p; bestDist = d }
    }
    return best
  }

  // ── DRAW LOOP ────────────────────────────────────────────────────────────
  _loop(now) {
    if (this._stopped) return
    if (!this.lastFrame) this.lastFrame = now
    const dt = Math.min(0.06, (now - this.lastFrame) / 1000)
    this.lastFrame = now
    this.t += dt
    if (this.hintAlpha > 0 && this._touched) this.hintAlpha = Math.max(0, this.hintAlpha - dt * 0.9)

    this._draw()
    requestAnimationFrame(this._loop)
  }

  _draw() {
    const { ctx, w, h } = this
    if (!w || !h) return

    // Background
    const grad = ctx.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.85)
    grad.addColorStop(0,   'rgba(28, 22, 50, 1)')
    grad.addColorStop(0.5, 'rgba(12, 13, 30, 1)')
    grad.addColorStop(1,   'rgba(6, 8, 15, 1)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)

    const neb = ctx.createRadialGradient(w * 0.7, h * 0.3, 0, w * 0.7, h * 0.3, Math.max(w, h) * 0.5)
    neb.addColorStop(0, 'rgba(167, 139, 250, 0.18)')
    neb.addColorStop(1, 'rgba(167, 139, 250, 0)')
    ctx.fillStyle = neb; ctx.fillRect(0, 0, w, h)
    const neb2 = ctx.createRadialGradient(w * 0.2, h * 0.75, 0, w * 0.2, h * 0.75, Math.max(w, h) * 0.45)
    neb2.addColorStop(0, 'rgba(56, 189, 248, 0.12)')
    neb2.addColorStop(1, 'rgba(56, 189, 248, 0)')
    ctx.fillStyle = neb2; ctx.fillRect(0, 0, w, h)

    // Stars
    for (const s of this.stars) {
      const tw = (Math.sin(this.t * 1.4 + s.tw) + 1) * 0.5
      const alpha = 0.35 + tw * 0.6
      const px = ((s.x + this.t * 0.004) % 1) * w
      const py = s.y * h
      const tone = s.hue === 'violet' ? '167,139,250' : s.hue === 'cyan' ? '56,189,248' : '255,255,255'
      ctx.fillStyle = `rgba(${tone},${alpha})`
      ctx.beginPath()
      ctx.arc(px, py, s.r, 0, Math.PI * 2)
      ctx.fill()
    }

    const cx = w / 2, cy = h / 2

    // Center star
    const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22 * this.cam.zoom)
    sun.addColorStop(0,   'rgba(255, 224, 156, 1)')
    sun.addColorStop(0.4, 'rgba(252, 211, 77, 0.55)')
    sun.addColorStop(1,   'rgba(252, 211, 77, 0)')
    ctx.fillStyle = sun
    ctx.beginPath()
    ctx.arc(cx, cy, 22 * this.cam.zoom, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fef3c7'
    ctx.beginPath()
    ctx.arc(cx, cy, 3.2 * this.cam.zoom, 0, Math.PI * 2)
    ctx.fill()

    if (!this.planets.length) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.45)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('// awaiting query', cx, cy + 56)
      return
    }

    const radiusUnit = Math.min(w, h * 2.4) * 0.13

    // Orbits (depth-aware in 3D)
    for (const p of this.planets) {
      ctx.strokeStyle = p.color.ring
      ctx.lineWidth = 0.8
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      const STEPS = this.mode === '3d' ? 96 : 64
      for (let i = 0; i <= STEPS; i++) {
        const a = (i / STEPS) * Math.PI * 2
        const lx = Math.cos(a) * p.orbit * radiusUnit
        const ly = Math.sin(a) * p.orbit * radiusUnit
        let x = lx, y = ly, z = 0
        if (this.mode === '3d') {
          y = ly * Math.cos(p.inclination)
          z = ly * Math.sin(p.inclination)
        }
        const pr = this._project(x, y, z)
        const sx = cx + pr.x, sy = cy + pr.y
        if (i === 0) ctx.moveTo(sx, sy)
        else         ctx.lineTo(sx, sy)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Planets — depth-sort so back ones render first in 3D
    const drawList = this.planets.map(p => {
      const a = this.t * p.speed + p.phase
      const lx = Math.cos(a) * p.orbit * radiusUnit
      const ly = Math.sin(a) * p.orbit * radiusUnit
      let x = lx, y = ly, z = 0
      if (this.mode === '3d') {
        y = ly * Math.cos(p.inclination)
        z = ly * Math.sin(p.inclination)
      }
      return { p, proj: this._project(x, y, z) }
    })
    drawList.sort((a, b) => a.proj.z - b.proj.z)

    for (const { p, proj } of drawList) {
      const sx = cx + proj.x, sy = cy + proj.y
      const size = p.baseSize * proj.scale
      if (size < 0.5) continue
      const isHover = this.hover === p.slug

      const gl = ctx.createRadialGradient(sx, sy, 0, sx, sy, size * (isHover ? 4.5 : 3))
      gl.addColorStop(0, p.color.glow)
      gl.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = gl
      ctx.beginPath()
      ctx.arc(sx, sy, size * (isHover ? 4.5 : 3), 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = p.color.planet
      ctx.beginPath()
      ctx.arc(sx, sy, size, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 0.6
      ctx.stroke()

      if (isHover) {
        ctx.fillStyle = 'rgba(230, 236, 245, 0.95)'
        ctx.font = '11px ui-monospace, monospace'
        ctx.textAlign = 'center'
        ctx.fillText(p.slug, sx, sy - size - 8)
      }
    }

    // Interaction hint (3D only, fades after first user interaction)
    if (this.mode === '3d' && this.hintAlpha > 0.01) {
      ctx.save()
      ctx.globalAlpha = this.hintAlpha
      const hint = '✶ drag to rotate · pinch / scroll to zoom'
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'left'
      const padX = 10, padY = 6
      const tw = ctx.measureText(hint).width
      const x0 = 12, y0 = h - 12 - 22
      ctx.fillStyle = 'rgba(10, 13, 20, 0.6)'
      ctx.strokeStyle = 'rgba(167, 139, 250, 0.35)'
      ctx.lineWidth = 1
      const r = 11
      const x1 = x0 + tw + padX * 2, y1 = y0 + 22
      roundRect(ctx, x0, y0, x1 - x0, y1 - y0, r)
      ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(167, 139, 250, 0.9)'
      ctx.fillText(hint, x0 + padX, y0 + 15)
      ctx.restore()
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y,     x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x,     y + h, r)
  ctx.arcTo(x,     y + h, x,     y,     r)
  ctx.arcTo(x,     y,     x + w, y,     r)
  ctx.closePath()
}

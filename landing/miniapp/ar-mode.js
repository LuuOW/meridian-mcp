// ar-mode.js — camera + real-time object detection (TensorFlow.js + COCO-SSD).
//
// Frames stay in the browser. Only detected class names are passed up to the
// host page (which feeds them to /api/dynamic-route). Lazy-loads the ~6 MB
// TF.js bundle from a CDN the first time AR is opened — text-only users
// pay zero cost.

const TF_CDN     = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js'
const COCO_CDN   = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'

let _stream    = null
let _model     = null
let _stopped   = false
let _scanFrame = null
let _locked    = false   // when true, detection runs (boxes drawn) but no route calls fire

const lastEmittedAt = new Map()
const EMIT_COOLDOWN_MS = 3000

// Caller flips this after a route call completes. While locked, the
// detection loop continues (overlay still updates, frames stay live)
// but onDetectedClass is suppressed — no new queries spawn.
export function lockAR()   { _locked = true;  lastEmittedAt.clear() }
export function unlockAR() { _locked = false; lastEmittedAt.clear() }
export function isLocked() { return _locked }

export async function startAR({ stream, videoEl, overlayEl, statusEl, detsEl, onDetectedClass }) {
  _stopped = false
  statusEl.textContent = 'requesting camera…'

  // 1. Camera stream — caller passed an in-flight getUserMedia Promise
  //    (started synchronously in the click handler so Safari doesn't drop
  //    the user-gesture). If that promise rejects, surface a clean error.
  try {
    _stream = await stream
  } catch (e) {
    const name = e?.name || ''
    let msg
    if      (name === 'NotAllowedError')   msg = 'camera permission denied (check Settings → Safari → Camera, or browser site settings)'
    else if (name === 'NotFoundError')     msg = 'no camera found on this device'
    else if (name === 'NotReadableError')  msg = 'camera is busy in another app'
    else if (name === 'OverconstrainedError') msg = 'no camera matches the requested constraints'
    else                                   msg = `camera failed: ${e?.message || name || 'unknown'}`
    throw new Error(msg)
  }
  videoEl.srcObject = _stream
  // iOS Safari needs an explicit play() with the stream attached.
  try { await videoEl.play() } catch {}

  // Match overlay canvas to displayed video dimensions
  const fitOverlay = () => {
    const r = videoEl.getBoundingClientRect()
    overlayEl.width  = r.width  * (window.devicePixelRatio || 1)
    overlayEl.height = r.height * (window.devicePixelRatio || 1)
    overlayEl.style.width  = r.width  + 'px'
    overlayEl.style.height = r.height + 'px'
  }
  fitOverlay()
  videoEl.addEventListener('loadedmetadata', fitOverlay, { once: true })
  window.addEventListener('resize', fitOverlay)

  // 2. Lazy-load TF.js + COCO-SSD if not already loaded
  if (!_model) {
    statusEl.textContent = 'loading model (~6 MB, first time only)…'
    try {
      await loadScript(TF_CDN)
      await loadScript(COCO_CDN)
      // tf is now globally available
      _model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' })
    } catch (e) {
      throw new Error(`model load failed: ${e.message}`)
    }
  }

  statusEl.textContent = 'scanning…'
  _scanFrame = requestAnimationFrame(scanLoop)

  async function scanLoop() {
    if (_stopped) return
    if (videoEl.readyState >= 2 && _model) {
      const dets = await _model.detect(videoEl, 5, 0.55)
      drawOverlay(overlayEl, videoEl, dets)
      renderDetectionsList(detsEl, dets)
      if (!_locked) {
        // Pick only the SINGLE highest-confidence detection per frame and
        // emit it once per cooldown window. Lock immediately on emit so
        // subsequent frames don't queue concurrent calls.
        const top = dets.reduce((a, b) => (!a || b.score > a.score) ? b : a, null)
        if (top) {
          const now = Date.now()
          const last = lastEmittedAt.get(top.class) || 0
          if (now - last > EMIT_COOLDOWN_MS) {
            lastEmittedAt.set(top.class, now)
            _locked = true   // self-lock; caller calls unlockAR() to re-arm
            try { onDetectedClass(top.class) } catch {}
          }
        }
      }
    }
    _scanFrame = requestAnimationFrame(scanLoop)
  }
}

export function stopAR() {
  _stopped = true
  if (_scanFrame) cancelAnimationFrame(_scanFrame)
  _scanFrame = null
  if (_stream) {
    for (const t of _stream.getTracks()) t.stop()
    _stream = null
  }
  lastEmittedAt.clear()
}

// ── helpers ───────────────────────────────────────────────────────────────

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`)
    if (existing) {
      if (existing.dataset.loaded) return resolve()
      existing.addEventListener('load',  () => { existing.dataset.loaded = '1'; resolve() })
      existing.addEventListener('error', () => reject(new Error(`failed to load ${src}`)))
      return
    }
    const s = document.createElement('script')
    s.src = src
    s.async = true
    s.addEventListener('load',  () => { s.dataset.loaded = '1'; resolve() })
    s.addEventListener('error', () => reject(new Error(`failed to load ${src}`)))
    document.head.appendChild(s)
  })
}

function drawOverlay(canvas, video, dets) {
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const cw = canvas.width / dpr, ch = canvas.height / dpr
  ctx.clearRect(0, 0, cw, ch)

  // Map model coordinates (video native pixels) to displayed canvas size.
  const sx = cw / (video.videoWidth || cw)
  const sy = ch / (video.videoHeight || ch)

  ctx.lineWidth   = 2
  ctx.font        = '13px ui-monospace, monospace'
  ctx.textBaseline = 'top'

  for (const d of dets) {
    const [x, y, w, h] = d.bbox
    const X = x * sx, Y = y * sy, W = w * sx, H = h * sy

    ctx.strokeStyle = 'rgba(167, 139, 250, 0.95)'
    ctx.shadowColor = 'rgba(167, 139, 250, 0.7)'
    ctx.shadowBlur  = 12
    ctx.strokeRect(X, Y, W, H)
    ctx.shadowBlur  = 0

    const label = `${d.class} ${(d.score * 100).toFixed(0)}%`
    const tw = ctx.measureText(label).width + 12
    ctx.fillStyle = 'rgba(167, 139, 250, 0.9)'
    ctx.fillRect(X, Y - 19, tw, 19)
    ctx.fillStyle = '#0a0d14'
    ctx.fillText(label, X + 6, Y - 16)
  }
}

function renderDetectionsList(el, dets) {
  if (!dets.length) {
    el.hidden = true
    return
  }
  el.hidden = false
  const uniq = new Map()
  for (const d of dets) {
    const cur = uniq.get(d.class)
    if (!cur || d.score > cur) uniq.set(d.class, d.score)
  }
  el.innerHTML = [...uniq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cls, sc]) => `<span class="ar-det-pill">${escape(cls)} <em>${(sc * 100).toFixed(0)}%</em></span>`)
    .join('')
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}

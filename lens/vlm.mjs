// lens vision-language helpers (server-side inference).
//
// The WebXR scene capture stays client-side — Three.js renders the
// player's POV to an offscreen target. The captured frame is then
// uploaded as a data URI to mcp.ask-meridian.uk/v1/vision (GPT-4o-mini
// via GH Models). The lens UX is preserved; only the inference moved.
//
// Public API matches the prior in-browser version exactly so the 1690
// LOC index.js consumes it unchanged.

import * as THREE from 'three'

const API_BASE = 'https://mcp.ask-meridian.uk'

// Stubbed — server-side inference doesn't need model preloading.
export function loadVlm(/* { onProgress, onStatus } */) {
  return Promise.resolve({ device: 'server' })
}
export function isVlmReady() { return true }
export async function requestPersistentStorage() {
  return { supported: false, persisted: false, server: true }
}

// ── Webcam capture ───────────────────────────────────────────────────
let _cameraStream = null
let _cameraVideo  = null

export async function requestCamera({ facingMode = 'environment' } = {}) {
  if (_cameraVideo && _cameraStream?.active) return _cameraVideo
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported')

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: 1280, height: 720 }, audio: false,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  }
  _cameraStream = stream

  const video = document.createElement('video')
  video.autoplay = true; video.playsInline = true; video.muted = true
  video.srcObject = stream
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;'
  document.body.appendChild(video)
  await new Promise((res) => {
    if (video.readyState >= 2) return res()
    video.addEventListener('loadeddata', res, { once: true })
  })
  await video.play().catch(() => {})
  _cameraVideo = video
  return video
}

export function isCameraReady() {
  return !!(_cameraVideo && _cameraStream?.active)
}

export function stopCamera() {
  try { _cameraStream?.getTracks?.().forEach(t => t.stop()) } catch {}
  if (_cameraVideo) {
    try { _cameraVideo.srcObject = null } catch {}
    try { _cameraVideo.remove() } catch {}
  }
  _cameraStream = null
  _cameraVideo  = null
}

const _camCanvas = (typeof OffscreenCanvas !== 'undefined')
  ? new OffscreenCanvas(384, 384)
  : Object.assign(document.createElement('canvas'), { width: 384, height: 384 })

// Returns a data: URI of the current camera frame at `size`×`size`.
// Replaces the prior RawImage return — /v1/vision wants a URI.
export function captureCameraFrame(size = 384) {
  if (!_cameraVideo) throw new Error('camera not requested')
  if (_camCanvas.width !== size) { _camCanvas.width = size; _camCanvas.height = size }
  const ctx = _camCanvas.getContext('2d')
  const vw = _cameraVideo.videoWidth, vh = _cameraVideo.videoHeight
  const side = Math.min(vw, vh)
  ctx.drawImage(_cameraVideo, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, size, size)
  return canvasToDataUri(_camCanvas)
}

// ── Scene capture (WebXR) ────────────────────────────────────────────
const _capCam = new THREE.PerspectiveCamera(70, 1, 0.05, 100)
let _capTarget = null
let _capPixels = null
const _vWorldPos  = new THREE.Vector3()
const _vWorldQuat = new THREE.Quaternion()

export function captureSceneFrame({ renderer, scene, player, size = 384 }) {
  if (!_capTarget) {
    _capTarget = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: true, stencilBuffer: false,
      type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    })
    _capPixels = new Uint8Array(size * size * 4)
  }

  const xrCam = renderer.xr?.getCamera?.()
  if (xrCam?.cameras?.length) {
    xrCam.matrixWorld.decompose(_vWorldPos, _vWorldQuat, new THREE.Vector3())
    _capCam.position.copy(_vWorldPos)
    _capCam.quaternion.copy(_vWorldQuat)
  } else {
    _capCam.position.copy(player.position)
    _capCam.position.y += 1.6
    _capCam.quaternion.copy(player.quaternion)
  }
  _capCam.updateMatrixWorld(true)

  const prevTarget    = renderer.getRenderTarget()
  const prevXrEnabled = renderer.xr.enabled
  renderer.xr.enabled = false
  renderer.setRenderTarget(_capTarget)
  renderer.clear()
  renderer.render(scene, _capCam)
  renderer.readRenderTargetPixels(_capTarget, 0, 0, size, size, _capPixels)
  renderer.setRenderTarget(prevTarget)
  renderer.xr.enabled = prevXrEnabled

  // WebGL origin is bottom-left, image-space is top-left — flip + drop alpha.
  const out = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size })
  const ctx = out.getContext('2d')
  const id  = ctx.createImageData(size, size)
  const stride = size * 4
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride
    id.data.set(_capPixels.subarray(src, src + stride), y * stride)
  }
  ctx.putImageData(id, 0, 0)
  return canvasToDataUri(out)
}

// ── Inference ────────────────────────────────────────────────────────
// Streams the model output via a single fetch (no token-level streaming
// from /v1/vision today — could be added with SSE later). onToken is
// called once with the final answer for callers that expected streaming.
export async function describeImage(imageDataUri, prompt, { onToken, signal, maxTokens = 96 } = {}) {
  const ctrl = new AbortController()
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true })
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const res = await fetch(API_BASE + '/v1/vision', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ image_url: imageDataUri, prompt }),
      signal:  ctrl.signal,
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    const text = (j.description || '').trim()
    onToken?.(text, text)
    return text
  } finally {
    clearTimeout(timer)
  }
}

// ── helpers ──────────────────────────────────────────────────────────
async function canvasToDataUri(canvas) {
  if (canvas.convertToBlob) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    return new Promise((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(fr.result)
      fr.onerror = rej
      fr.readAsDataURL(blob)
    })
  }
  return canvas.toDataURL('image/jpeg', 0.85)
}

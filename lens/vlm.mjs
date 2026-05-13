// lens-specific vision-language wrapper.
//
// The reusable bits (model load, IDB version pin, WebGPU/WASM fallback,
// persistent storage) live in /_lib/edge-inference.mjs and are shared
// with helix / future browser apps under meridian.ask-meridian.uk.
//
// This file keeps only what lens uniquely needs:
//   • WebXR scene capture (Three.js render-to-texture from the player POV)
//   • Webcam stream + frame capture (DOM camera path)
//   • describeImage — token-streaming chat that matches the lens UX
//
// The export surface matches the prior lens/vlm.mjs API exactly, so
// index.js consumes it unchanged.

import * as THREE from 'three'
import { RawImage, TextStreamer } from '@huggingface/transformers'

import { loadVision, isLoaded, requestPersistentStorage as reqPersist }
  from '/_lib/edge-inference.mjs'

// ── Re-exports from _lib ─────────────────────────────────────────────
export const requestPersistentStorage = reqPersist
export const isVlmReady = () => isLoaded('vision')

// loadVlm matches the old signature (onProgress / onStatus). Returns
// { processor, model, device } — same shape index.js was destructuring.
export function loadVlm({ onProgress, onStatus } = {}) {
  return loadVision({ onProgress, onStatus })
}

// ── Webcam capture ───────────────────────────────────────────────────
let _cameraStream = null
let _cameraVideo  = null

export async function requestCamera({ facingMode = 'environment' } = {}) {
  if (_cameraVideo && _cameraStream?.active) return _cameraVideo
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error('getUserMedia not supported')

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: 1280, height: 720 },
      audio: false,
    })
  } catch {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
  }
  _cameraStream = stream

  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  video.muted = true
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

export function captureCameraFrame(size = 384) {
  if (!_cameraVideo) throw new Error('camera not requested')
  if (_camCanvas.width !== size) { _camCanvas.width = size; _camCanvas.height = size }
  const ctx = _camCanvas.getContext('2d')

  const vw = _cameraVideo.videoWidth, vh = _cameraVideo.videoHeight
  const side = Math.min(vw, vh)
  const sx = (vw - side) / 2, sy = (vh - side) / 2
  ctx.drawImage(_cameraVideo, sx, sy, side, side, 0, 0, size, size)

  const data = ctx.getImageData(0, 0, size, size).data
  const rgb = new Uint8ClampedArray(size * size * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j]     = data[i]
    rgb[j + 1] = data[i + 1]
    rgb[j + 2] = data[i + 2]
  }
  return new RawImage(rgb, size, size, 3)
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

  // WebGL origin is bottom-left, image-space is top-left — flip.
  const flipped = new Uint8ClampedArray(_capPixels.length)
  const stride = size * 4
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride
    flipped.set(_capPixels.subarray(src, src + stride), y * stride)
  }

  const rgb = new Uint8ClampedArray(size * size * 3)
  for (let i = 0, j = 0; i < flipped.length; i += 4, j += 3) {
    rgb[j]     = flipped[i]
    rgb[j + 1] = flipped[i + 1]
    rgb[j + 2] = flipped[i + 2]
  }
  return new RawImage(rgb, size, size, 3)
}

// ── Inference ────────────────────────────────────────────────────────
// Same prompt / sampling defaults the lens UX was tuned around.
export async function describeImage(image, prompt, { onToken, signal, maxTokens = 96 } = {}) {
  const { processor, model } = await loadVision()
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  const messages = [{
    role: 'user',
    content: [{ type: 'image' }, { type: 'text', text: prompt }],
  }]
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true })
  const inputs = await processor(text, [image])

  let buffer = ''
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (chunk) => {
      buffer += chunk
      onToken?.(buffer, chunk)
    },
  })

  await model.generate({
    ...inputs,
    max_new_tokens:    maxTokens,
    do_sample:         true,
    temperature:       0.5,
    top_p:             0.9,
    repetition_penalty: 1.0,
    streamer,
  })

  return buffer.replace(/^\s*Assistant:\s*/i, '').trim()
}

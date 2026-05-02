// Vision Lab — Phase 1+2+3
//
// Phase 1 verification path:
//   - capability check (WebGPU, OPFS, camera, storage estimate)
//   - one-time gated download from HF CDN
//   - camera capture, run inference, render answer
// Phase 2 polish:
//   - real progress bar via transformers.js progress_callback
//   - persistent storage via navigator.storage.persist()
//   - streaming token output via TextStreamer
//   - preset prompt chips, custom prompt input
//   - Moondream2 primary, SmolVLM-500M fallback if Moondream load fails
// Phase 3 composition:
//   - "Find compatible skills" → POST /api/orbital-route with VLM answer
//
// All inference runs in the user's browser. The VM is uninvolved.

import {
  pipeline,
  env,
  RawImage,
  TextStreamer,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0'

// Force network fetches to HF (don't try local /models/...)
env.allowLocalModels = false
env.useBrowserCache  = true

const MODELS = {
  moondream: {
    id:    'onnx-community/moondream2',
    label: 'Moondream2',
    dtype: { embed_tokens: 'fp16', vision_encoder: 'fp16', decoder_model_merged: 'q4' },
    expected_size_mb: 1600,
  },
  smolvlm: {
    id:    'HuggingFaceTB/SmolVLM-500M-Instruct',
    label: 'SmolVLM-500M',
    dtype: 'q4',
    expected_size_mb: 500,
  },
}

const $ = id => document.getElementById(id)

// ── State ─────────────────────────────────────────────────────────────────
let pipe              = null
let stream            = null
let conversation      = []          // [{ role, content }]
let lastAnswer        = ''
let modelKey          = 'smolvlm'
let currentFacingMode = 'environment'
let frozenFrameURL    = null

// ── Burger menu ───────────────────────────────────────────────────────────
;(function () {
  const btn  = document.getElementById('burgerBtn')
  const menu = document.getElementById('navMenu')
  if (!btn || !menu) return
  const toggle = (open) => {
    const isOpen = open !== undefined ? open : !menu.classList.contains('open')
    menu.classList.toggle('open', isOpen)
    btn.classList.toggle('open', isOpen)
    btn.setAttribute('aria-expanded', String(isOpen))
  }
  btn.addEventListener('click', e => { e.stopPropagation(); toggle() })
  menu.querySelectorAll('a').forEach(a => a.addEventListener('click', () => toggle(false)))
  document.addEventListener('click', e => {
    if (!menu.classList.contains('open')) return
    if (!menu.contains(e.target) && !btn.contains(e.target)) toggle(false)
  })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggle(false) })
})();

// ── Capability check ──────────────────────────────────────────────────────
checkCapabilities()

async function checkCapabilities() {
  const lines = []
  let ok = true

  // WebGPU
  let webgpuOK = false
  if ('gpu' in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter()
      if (adapter) {
        webgpuOK = true
        const info = adapter.info ? `${adapter.info.vendor || ''} ${adapter.info.architecture || ''}`.trim() : ''
        lines.push({ ok: true, text: `WebGPU available${info ? ' (' + info + ')' : ''}` })
      } else {
        lines.push({ ok: false, text: 'WebGPU API exists but no adapter — falling back to WASM (slower)' })
      }
    } catch (e) {
      lines.push({ ok: false, text: 'WebGPU error: ' + e.message })
    }
  } else {
    lines.push({ ok: false, text: 'No WebGPU — use Chrome 113+, Safari 18+, or Firefox 141+' })
    ok = false
  }

  // OPFS / persistent storage
  if (navigator.storage?.getDirectory) {
    lines.push({ ok: true, text: 'Persistent storage (OPFS) available' })
    if (navigator.storage?.persisted) {
      const already = await navigator.storage.persisted()
      if (already) lines.push({ ok: true, text: 'Storage already marked persistent ✓' })
    }
  } else {
    lines.push({ ok: false, text: 'OPFS missing — model may be evicted under storage pressure' })
  }

  // Camera
  if (!navigator.mediaDevices?.getUserMedia) {
    lines.push({ ok: false, text: 'Camera API unavailable' })
    ok = false
  } else {
    lines.push({ ok: true, text: 'Camera API available' })
  }

  // Storage estimate
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate()
      const gb  = (est.quota / (1024 ** 3)).toFixed(1)
      const used = (est.usage / (1024 ** 3)).toFixed(2)
      lines.push({ ok: true, text: `Storage quota: ~${gb} GB total (${used} GB used)` })
    } catch {}
  }

  $('capabilityCheck').innerHTML = lines.map(l =>
    `<div class="cap-line ${l.ok ? 'cap-ok' : 'cap-bad'}">${l.ok ? '✓' : '⚠'} ${escapeHTML(l.text)}</div>`
  ).join('')

  if (!ok) {
    $('startBtn').disabled = true
    $('startBtn').textContent = 'Browser doesn\'t support this'
  }
}

// ── Start setup ───────────────────────────────────────────────────────────
$('startBtn').addEventListener('click', startSetup)
$('modelChoice').addEventListener('change', e => { modelKey = e.target.value })

async function startSetup() {
  modelKey = $('modelChoice').value
  $('gate').hidden = true
  $('loading').hidden = false

  try {
    // Persistent storage — best-effort, browsers may silently grant or deny.
    if (navigator.storage?.persist) {
      try {
        const granted = await navigator.storage.persist()
        $('progressDetail').textContent = granted ? 'Persistent storage granted ✓' : 'Browser will keep model under best-effort quota'
      } catch {}
    }

    await loadModel(modelKey)
    await openCamera()

    $('loading').hidden = true
    $('lab').hidden = false
    diag(`Loaded: ${MODELS[modelKey].label}\nDevice: webgpu (or fallback)\nReady at: ${new Date().toLocaleTimeString()}`)
  } catch (e) {
    console.error(e)
    $('progressText').textContent = 'Setup failed: ' + (e.message || e)
    $('progressText').classList.add('err')
    if (modelKey === 'moondream') {
      // Auto-fallback to SmolVLM
      $('progressDetail').innerHTML = 'Trying SmolVLM-500M fallback in 2s…'
      setTimeout(() => { modelKey = 'smolvlm'; startSetup() }, 2000)
    }
  }
}

async function loadModel(key) {
  const m = MODELS[key]
  $('progressText').textContent = `Fetching ${m.label} (~${m.expected_size_mb} MB compressed)…`
  const seenFiles = new Map()
  const totalBytes = m.expected_size_mb * 1024 * 1024
  let loadedBytes = 0

  pipe = await pipeline('image-text-to-text', m.id, {
    device: 'webgpu',
    dtype:  m.dtype,
    progress_callback: (p) => {
      if (p.status === 'progress') {
        const prev = seenFiles.get(p.file) || 0
        loadedBytes += (p.loaded - prev)
        seenFiles.set(p.file, p.loaded)
        const pct = Math.min(99, Math.round(loadedBytes / totalBytes * 100))
        $('progressBar').value = pct
        $('progressText').textContent = `${m.label} — ${p.file}`
        $('progressDetail').textContent = `${(loadedBytes / (1024 ** 2)).toFixed(1)} MB · ~${pct}%`
      } else if (p.status === 'done') {
        $('progressDetail').textContent = `${p.file} ready ✓`
      } else if (p.status === 'ready') {
        $('progressBar').value = 100
        $('progressText').textContent = 'Compiling shaders for WebGPU…'
      }
    },
  })

  $('progressBar').value = 100
  $('progressText').textContent = m.label + ' loaded ✓'
}

async function openCamera() {
  $('progressText').textContent = 'Requesting camera…'
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: currentFacingMode }, width: { ideal: 960 }, height: { ideal: 720 } },
    audio: false,
  })
  $('video').srcObject = stream
  await $('video').play().catch(() => {})
}

// ── Snap + flip ───────────────────────────────────────────────────────────
$('snapBtn').addEventListener('click', () => {
  const v = $('video')
  const c = $('snapCanvas')
  c.width  = v.videoWidth || 640
  c.height = v.videoHeight || 480
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
  c.hidden = false
  v.style.opacity = '0.25'
  $('frozenBadge').hidden = false
  frozenFrameURL = c.toDataURL('image/jpeg', 0.9)
})

$('flipBtn').addEventListener('click', async () => {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment'
  if (stream) for (const t of stream.getTracks()) t.stop()
  await openCamera()
  $('snapCanvas').hidden = true
  $('video').style.opacity = '1'
  $('frozenBadge').hidden = true
  frozenFrameURL = null
})

// ── Preset prompts ────────────────────────────────────────────────────────
document.querySelectorAll('.lab-preset').forEach(b => {
  b.addEventListener('click', () => {
    $('customPrompt').value = b.dataset.prompt
    $('askForm').requestSubmit()
  })
})

// ── Ask form ──────────────────────────────────────────────────────────────
$('askForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const prompt = $('customPrompt').value.trim() || 'What is in this image?'
  await ask(prompt)
})

$('askAgainBtn').addEventListener('click', () => {
  $('customPrompt').focus()
})

async function ask(prompt) {
  if (!pipe) return
  // Capture a frame if not already frozen
  let imgURL = frozenFrameURL
  if (!imgURL) {
    const v = $('video')
    const c = $('snapCanvas')
    c.width  = v.videoWidth || 640
    c.height = v.videoHeight || 480
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height)
    imgURL = c.toDataURL('image/jpeg', 0.9)
  }

  $('answerSection').hidden = false
  $('answer').textContent   = ''
  $('latencyBadge').textContent = '⏳ thinking…'
  $('askBtn').disabled = true
  $('routeBtn').hidden = true

  const t0 = performance.now()
  try {
    const image = await RawImage.fromURL(imgURL)

    // Build messages — keep prior turns for multi-turn
    const messages = [
      ...conversation,
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] },
    ]

    // Streaming token output
    const tokenizer = pipe.tokenizer
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        $('answer').textContent += chunk
      },
    })

    const out = await pipe(messages, { images: [image], max_new_tokens: 256, do_sample: false, streamer })
    const generated = (out?.[0]?.generated_text || '').trim()
    if (!$('answer').textContent && generated) $('answer').textContent = generated  // non-streaming fallback

    lastAnswer = $('answer').textContent.trim()
    conversation.push({ role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] })
    conversation.push({ role: 'assistant', content: lastAnswer })

    // Cap conversation length to last 4 turns to avoid context bloat
    if (conversation.length > 8) conversation = conversation.slice(-8)

    const ms = Math.round(performance.now() - t0)
    $('latencyBadge').textContent = `${(ms / 1000).toFixed(1)}s`
    $('routeBtn').hidden    = false
    $('askAgainBtn').hidden = false
    diag(`Q: ${prompt}\nA: ${lastAnswer}\nLatency: ${ms} ms`)
  } catch (e) {
    console.error(e)
    $('answer').textContent = 'Error: ' + (e.message || e)
    $('latencyBadge').textContent = '✗'
  } finally {
    $('askBtn').disabled = false
  }
}

// ── Phase 3: route the VLM answer through the orbital pipeline ────────────
$('routeBtn').addEventListener('click', async () => {
  if (!lastAnswer) return
  const orig = $('routeBtn').textContent
  $('routeBtn').disabled = true
  $('routeBtn').textContent = 'Routing through orbital engine…'
  try {
    // Send to /api/orbital-route — the same backend the main miniapp uses
    const r = await fetch('/api/orbital-route', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: lastAnswer.length > 600 ? lastAnswer.slice(0, 600) + '…' : lastAnswer,
        limit: 5,
        provider: 'groq',
      }),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)

    // Open the main miniapp in a new tab with the task pre-filled? Or render inline?
    // Inline is simpler — show the top 5 here.
    const html = data.selected.map(s => `
      <li class="lab-route-result">
        <strong>${escapeHTML(s.slug)}</strong>
        <span class="lab-route-class" data-class="${escapeHTML(s.classification?.class || '')}">${escapeHTML(s.classification?.class || '')}</span>
        <p>${escapeHTML(s.description || '')}</p>
      </li>
    `).join('')
    $('answer').insertAdjacentHTML('afterend', `
      <div class="lab-route-results">
        <h4>Top ${data.selected.length} skills (orbital-classified)</h4>
        <ol>${html}</ol>
        <p class="lab-route-foot">
          Provider: <code>${escapeHTML(data.provider || '?')}</code> ·
          Latency: ${(data.timing?.total_ms / 1000 || 0).toFixed(1)}s ·
          <a href="/miniapp/?task=${encodeURIComponent(lastAnswer.slice(0, 200))}">Open in main miniapp</a>
        </p>
      </div>
    `)
    $('routeBtn').hidden = true
  } catch (e) {
    alert('Routing failed: ' + e.message)
  } finally {
    $('routeBtn').disabled = false
    $('routeBtn').textContent = orig
  }
})

// ── utils ─────────────────────────────────────────────────────────────────
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]))
}
function diag(s) { $('diag').textContent = s }

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

// transformers.js doesn't expose VLMs through the pipeline() abstraction —
// you have to load the processor + model classes directly. This is the
// canonical SmolVLM/Moondream pattern from the HF docs.
import {
  AutoProcessor,
  AutoModelForVision2Seq,
  RawImage,
  TextStreamer,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5'

// Force network fetches to HF (don't try local /models/...)
env.allowLocalModels = false
env.useBrowserCache  = true

const MODELS = {
  smolvlm: {
    id:    'HuggingFaceTB/SmolVLM-500M-Instruct',
    label: 'SmolVLM-500M',
    dtype: 'q4',
    expected_size_mb: 500,
  },
}

const $ = id => document.getElementById(id)

// ── State ─────────────────────────────────────────────────────────────────
let processor         = null
let model             = null
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
  if (!MODELS[modelKey]) modelKey = 'smolvlm'
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
    const msg = e?.message || String(e)
    $('progressText').textContent = 'Setup failed: ' + msg
    $('progressText').classList.add('err')

    // A "Unsupported pipeline" error means transformers.js version is the
    // culprit, not the model — falling back to a different model won't help.
    if (/unsupported pipeline/i.test(msg)) {
      $('progressDetail').innerHTML =
        'This is a transformers.js version issue, not a model issue. ' +
        'Hard-refresh the page (Cmd+Shift+R) and try again — the new bundle should load.'
      return
    }
    $('progressDetail').innerHTML =
      'Model failed to load. Check the browser console for the full stack trace, ' +
      'or open an issue with the message above at <a href="https://github.com/LuuOW/meridian-mcp/issues">github.com/LuuOW/meridian-mcp/issues</a>.'
  }
}

async function loadModel(key) {
  const m = MODELS[key]
  $('progressText').textContent = `Fetching ${m.label} (~${m.expected_size_mb} MB compressed)…`
  const seenFiles = new Map()
  const totalBytes = m.expected_size_mb * 1024 * 1024
  let loadedBytes = 0

  const progress_callback = (p) => {
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
  }

  // Direct class loading is the supported path for VLMs in transformers.js.
  // The pipeline() abstraction predates VLMs and doesn't have a unified entry
  // for them — `image-to-text` works for caption-only models, not chat VLMs.
  processor = await AutoProcessor.from_pretrained(m.id, { progress_callback })
  model     = await AutoModelForVision2Seq.from_pretrained(m.id, {
    device: 'webgpu',
    dtype:  m.dtype,
    progress_callback,
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
  if (!processor || !model) return
  // Capture a frame if not already frozen. Draw to an offscreen canvas so the
  // visible <canvas id="snapCanvas"> stays untouched (and hidden) — otherwise
  // the asked frame would paint over the live video and look "stuck".
  let imgURL = frozenFrameURL
  if (!imgURL) {
    const v = $('video')
    const c = document.createElement('canvas')
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

    // Each ask is treated as an independent turn — the user is usually asking
    // about the *current* frame, not building on prior conversation, and
    // SmolVLM's chat template chokes if assistant message `content` is a
    // string rather than a parts-array. Multi-turn can come back later with
    // properly-shaped historical messages.
    const messages = [
      { role: 'user', content: [{ type: 'image' }, { type: 'text', text: prompt }] },
    ]

    // Tokenize via the processor's chat template
    const text = processor.apply_chat_template(messages, { add_generation_prompt: true })
    const inputs = await processor(text, [image], { return_tensors: 'pt' })

    // Streaming token output via TextStreamer (uses processor.tokenizer)
    const streamer = new TextStreamer(processor.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (chunk) => {
        $('answer').textContent += chunk
      },
    })

    const generated_ids = await model.generate({
      ...inputs,
      max_new_tokens: 256,
      do_sample:      false,
      streamer,
    })

    // If streaming didn't fire (some browsers/builds drop the callback),
    // decode the full generation as a fallback.
    if (!$('answer').textContent.trim()) {
      const newTokens = generated_ids.slice(null, [inputs.input_ids.dims.at(-1), null])
      const decoded   = processor.batch_decode(newTokens, { skip_special_tokens: true })
      $('answer').textContent = (decoded[0] || '').trim()
    }

    lastAnswer = $('answer').textContent.trim()
    // (multi-turn history disabled for Phase 1 — see comment above)

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

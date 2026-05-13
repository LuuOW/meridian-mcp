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
//   - "Find compatible candidates" → POST mcp.ask-meridian.uk/v1/route
//     with the VLM answer; routing + orbital classification happen
//     server-side in the Cloudflare Worker.
//
// VLM inference still runs entirely in the user's browser. The VM is
// uninvolved; only the routing call leaves the browser, and that call
// goes to the operator-paid Meridian MCP, not to the user's machine.

// Inference now runs server-side at mcp.ask-meridian.uk/v1/vision
// (GPT-4o-mini via GH Models). No transformers.js download, no
// WebGPU compile — the captured frame goes up as a data: URI and the
// description comes back as plain text.

import { MiniGalaxy }        from '/miniapp/mini-galaxy.js'
import { renderPhysicsPanel } from '/miniapp/physics-panel.js'
import { routeTask, routeTaskStream, sendFeedback } from '/miniapp/api.js'
import { escapeHTML, renderMarkdown } from '/miniapp/_md.js'

const VISION_ENDPOINT = 'https://mcp.ask-meridian.uk/v1/vision'

// nav.js lives in the landing repo (ask-meridian.uk), not the shared
// origin. Vision-lab runs standalone here so the nav burger is a no-op.
const initBurgerNav = () => {}

// Force network fetches to HF (don't try local /models/...)
env.allowLocalModels = false

// OPFS-backed cache. The default Cache API silently drops large entries
// when quota is tight (especially on Safari) — OPFS is persistent by design
// and handles GB-sized model files reliably.
class OPFSCache {
  constructor(dir) { this.dir = dir }
  static async open() {
    if (typeof navigator?.storage?.getDirectory !== 'function')
      throw new Error('OPFS not available')
    const root = await navigator.storage.getDirectory()
    const dir  = await root.getDirectoryHandle('hf-models', { create: true })
    return new OPFSCache(dir)
  }
  _key(req) {
    const url = typeof req === 'string' ? req : req.url
    return url.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 240)
  }
  async match(req) {
    try {
      const fh   = await this.dir.getFileHandle(this._key(req))
      const file = await fh.getFile()
      return new Response(file, { status: 200, headers: { 'content-length': String(file.size) } })
    } catch { return undefined }
  }
  async put(req, response) {
    const buf = await response.arrayBuffer()
    const fh  = await this.dir.getFileHandle(this._key(req), { create: true })
    const w   = await fh.createWritable()
    await w.write(buf)
    await w.close()
  }
}

try {
  env.customCache     = await OPFSCache.open()
  env.useCustomCache  = true
  env.useBrowserCache = false
  console.info('vision-lab: OPFS cache enabled')
} catch (e) {
  env.useCustomCache  = false
  env.useBrowserCache = true
  console.warn('vision-lab: OPFS unavailable, falling back to Cache API:', e.message)
}

// Server-side vision: one model label exposed so the existing UI badges
// keep working; the worker decides the actual model (GPT-4o-mini default,
// swappable via the MERIDIAN_VISION_MODEL env var).
const MODELS = {
  smolvlm: {
    id:     'gpt-4o-mini',
    label:  'GPT-4o-mini (server)',
    family: 'server',
    dtype:  null,
    expected_size_mb: 0,
  },
}

const $ = id => document.getElementById(id)

// ── State ─────────────────────────────────────────────────────────────────
let processor         = null
let tokenizer         = null
let model             = null
let stream            = null
let conversation      = []          // [{ role, content }]
let lastAnswer        = ''
let modelKey          = 'smolvlm'
let currentFacingMode = 'environment'
let frozenFrameURL    = null
let arGalaxy          = null   // MiniGalaxy in AR mode, lazy-init on first route
let lastSelected      = []     // last route response, for in-stage panel lookup

// ── Burger menu ───────────────────────────────────────────────────────────
initBurgerNav()

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

  // OPFS cache contents — tells the user whether the model is already cached
  try {
    if (env.customCache?.dir) {
      let count = 0, bytes = 0
      for await (const [name, handle] of env.customCache.dir.entries()) {
        if (handle.kind === 'file') {
          count++
          const f = await handle.getFile()
          bytes += f.size
        }
      }
      const mb = (bytes / (1024 ** 2)).toFixed(0)
      lines.push({ ok: count > 0, text: count > 0
        ? `Model cache: ${count} files, ${mb} MB on disk (no re-download)`
        : 'Model cache: empty (first run will download ~1.6 GB)'
      })
    }
  } catch {}

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
  // Lock the model dropdown after setup begins. Swapping the value after the
  // model is loaded would silently update `modelKey` but ask() would still run
  // on the previously loaded weights — the dropdown would lie about reality.
  $('modelChoice').disabled = true
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
  // Server-side: no download, no compile. Set sentinels so ask() runs.
  const m = MODELS[key]
  processor = { server: true }
  tokenizer = null
  model     = { server: true }
  $('progressBar').value = 100
  $('progressText').textContent = `${m.label} ready (server-side)`
  $('progressDetail').textContent = 'no local model — inference at mcp.ask-meridian.uk/v1/vision'
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
  clearAnswerAndRoute()
})

$('flipBtn').addEventListener('click', async () => {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment'
  if (stream) for (const t of stream.getTracks()) t.stop()
  await openCamera()
  $('snapCanvas').hidden = true
  $('video').style.opacity = '1'
  $('frozenBadge').hidden = true
  frozenFrameURL = null
  clearAnswerAndRoute()
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

  // Clear any artifacts from the previous ask: route results card, AR galaxy
  // overlay, open candidate panel. The new answer is about a new frame/question, so
  // candidates routed from the prior answer would be misleading if left on screen.
  clearRouteArtifacts()

  $('answerSection').hidden = false
  $('answer').textContent   = ''
  $('latencyBadge').textContent = '⏳ thinking…'
  $('modelBadge').textContent   = MODELS[modelKey].label
  $('modelBadge').hidden        = false
  $('askBtn').disabled = true
  $('routeBtn').hidden = true
  $('askAgainBtn').hidden = true

  const t0 = performance.now()
  try {
    const res = await fetch(VISION_ENDPOINT, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ image_url: imgURL, prompt }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
    $('answer').textContent = (j.description || '').trim()
    lastAnswer = $('answer').textContent

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

  // Build the streaming results card up-front. Candidates get appended as
  // they arrive from the SSE stream; the foot line gets stamped on done.
  const t0 = performance.now()
  $('answer').insertAdjacentHTML('afterend', `
    <div class="lab-route-results lab-route-streaming" id="labRouteResults">
      <h4 id="labRouteHead">Routing through orbital engine…</h4>
      <p class="routing-progress" id="labRouteProgress">connecting…</p>
      <ol id="labRouteList"></ol>
      <p class="lab-route-foot" id="labRouteFoot" hidden></p>
    </div>
  `)
  const card     = $('labRouteResults')
  const head     = $('labRouteHead')
  const progress = $('labRouteProgress')
  const list     = $('labRouteList')
  const foot     = $('labRouteFoot')
  const accumulatedCandidates = []

  try {
    const summary = await routeTaskStream(
      {
        task:  lastAnswer.length > 600 ? lastAnswer.slice(0, 600) + '…' : lastAnswer,
        limit: 5,
      },
      {
        onProgress: (p) => {
          if (p.stage === 'connected')           progress.textContent = 'connected · waiting for LLM…'
          else if (p.stage === 'cache_hit')      progress.textContent = `cache hit (${p.cache_age_s}s old) — replaying`
          else if (p.stage === 'cache_miss')     progress.textContent = 'cache miss · authoring fresh candidates…'
          else if (p.stage === 'llm_streaming_start') progress.textContent = `LLM warming up (${p.model})…`
          else if (p.stage === 'llm_streaming')  progress.textContent = `LLM writing… ${p.chars.toLocaleString()} chars · ${(p.ms / 1000).toFixed(1)}s`
          else if (p.stage === 'llm_calling')    progress.textContent = `LLM running (${p.model})…`
          else if (p.stage === 'llm_complete')   progress.textContent = `LLM done in ${(p.ms / 1000).toFixed(1)}s · classifying…`
          else if (p.stage === 'rag_retrieved')  progress.textContent = `RAG: ${p.matches} similar past candidates (top score ${p.top_score})`
          else if (p.stage === 'classifying')    progress.textContent = `classifying ${p.candidates_generated} candidates orbitally…`
          else if (p.stage === 'semantic_rerank') progress.textContent = `semantic re-rank (${p.model})…`
        },
        onCandidate: (s) => {
          accumulatedCandidates.push(s)
          const cls   = s.classification?.class       || ''
          const sys   = s.classification?.star_system || ''
          const score = (s.route_score || 0).toFixed(1)
          // data-slug lets the click delegation below find the right
          // candidate for /v1/feedback without re-querying the DOM each time.
          list.insertAdjacentHTML('beforeend', `
            <li class="lab-route-result lab-route-result-in" data-slug="${escapeHTML(s.slug)}">
              <div class="lab-route-head">
                <strong>${escapeHTML(s.slug)}</strong>
                ${cls ? `<span class="lab-route-class" data-class="${escapeHTML(cls)}">${escapeHTML(cls)}</span>` : ''}
                ${sys ? `<span class="lab-route-system">${escapeHTML(sys)}</span>` : ''}
                <span class="lab-route-score">${score}</span>
              </div>
              <p>${escapeHTML(s.description || '')}</p>
              ${s.why ? `<div class="lab-route-why">${escapeHTML(s.why)}</div>` : ''}
            </li>`)
          // Update AR galaxy as each candidate arrives so the orbiting planets
          // appear progressively rather than all at once.
          showArGalaxy(accumulatedCandidates)
        },
      },
    )

    if (!accumulatedCandidates.length) {
      card.classList.remove('lab-route-streaming')
      card.classList.add('lab-route-empty')
      head.textContent = ''
      progress.textContent = ''
      list.innerHTML = ''
      foot.hidden = false
      foot.textContent = 'No compatible candidates found for this answer.'
      return
    }

    card.classList.remove('lab-route-streaming')
    head.textContent = `Top ${accumulatedCandidates.length} candidates (orbital-classified)`
    progress.hidden  = true
    foot.hidden      = false

    // Click delegation: any click on a card fires /v1/feedback with the
    // clicked card's slug as chosen. Bound once after the stream ends
    // so we don't re-bind on every onCandidate tick.
    const taskForFeedback = lastAnswer.slice(0, 600)
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-slug]')
      if (!li) return
      const chosenSlug = li.dataset.slug
      if (!chosenSlug || accumulatedCandidates.length < 2) return
      sendFeedback({
        task:       taskForFeedback,
        candidates:     accumulatedCandidates,
        chosenSlug,
        action:     'click',
      })
    }, { once: false })
    const wallMs = Math.round(performance.now() - t0)
    foot.innerHTML = `
      Classifier: <code>${escapeHTML(summary?.classifier || 'orbital-edge-v1')}</code> ·
      Wall: ${(wallMs / 1000).toFixed(1)}s ·
      <a href="/miniapp/?task=${encodeURIComponent(lastAnswer.slice(0, 200))}">Open in main miniapp</a>
    `
    $('routeBtn').hidden = true
  } catch (e) {
    // The streaming card already exists; rewrite it as the error card so
    // we don't double-render. clearRouteArtifacts() will sweep it away on
    // the next ask().
    card.classList.remove('lab-route-streaming')
    card.classList.add('lab-route-error')
    head.textContent     = ''
    progress.hidden      = true
    list.innerHTML       = ''
    foot.hidden          = false
    foot.innerHTML       = `<strong>Routing failed.</strong> ${escapeHTML(e.message || String(e))}`
  } finally {
    $('routeBtn').disabled = false
    $('routeBtn').textContent = orig
  }
})

// ── AR galaxy overlay (faked-3D over the camera) ──────────────────────────
function ensureArGalaxy() {
  if (arGalaxy) return arGalaxy
  arGalaxy = new MiniGalaxy($('arGalaxy'), {
    mode:   '3d',
    arMode: true,
    onPlanetClick: (slug) => openCandidatePanel(slug),
  })
  return arGalaxy
}

function showArGalaxy(candidates) {
  if (!candidates?.length) return
  lastSelected = candidates
  const g = ensureArGalaxy()
  g.setCandidates(candidates)
  $('arGalaxy').hidden = false
  $('galaxyBtn').hidden = false
  $('galaxyBtn').classList.add('active')
  document.querySelector('.lab-stage').classList.add('galaxy-on')
}

function openCandidatePanel(slug) {
  const s = lastSelected.find(x => x.slug === slug)
  if (!s) return
  const cls = s.classification?.class || ''
  const sys = s.classification?.star_system || ''
  const score = (s.route_score || 0).toFixed(1)
  const rule = s.classification?.decision_rule || ''
  const kw = Array.isArray(s.keywords) ? s.keywords.slice(0, 8) : []

  $('labCandidateTitle').textContent  = s.slug
  $('labCandidateClass').textContent  = cls
  $('labCandidateClass').dataset.class = cls
  $('labCandidateSystem').textContent = sys
  $('labCandidateSystem').style.display = sys ? '' : 'none'
  $('labCandidateScore').textContent  = `score ${score}`
  $('labCandidateDesc').textContent   = s.description || ''
  $('labCandidateRule').textContent   = rule
  $('labCandidatePhysics').innerHTML  = renderPhysicsPanel(s)
  $('labCandidateBody').innerHTML     = s.body
    ? renderMarkdown(s.body)
    : `<p class="lab-candidate-body-empty">No candidate body returned.</p>`
  $('labCandidateKeywords').innerHTML = kw.map(k => `<span class="lab-candidate-keyword">${escapeHTML(k)}</span>`).join('')
  $('labCandidateOpen').href = `/miniapp/?task=${encodeURIComponent(s.description || s.slug)}`

  const panel = $('labCandidatePanel')
  panel.classList.add('open')
  panel.setAttribute('aria-hidden', 'false')
}

function closeCandidatePanel() {
  const panel = $('labCandidatePanel')
  panel.classList.remove('open')
  panel.setAttribute('aria-hidden', 'true')
}

$('labCandidateClose').addEventListener('click', closeCandidatePanel)
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCandidatePanel() })

$('galaxyBtn').addEventListener('click', () => {
  const stage = document.querySelector('.lab-stage')
  const on = !stage.classList.contains('galaxy-on')
  stage.classList.toggle('galaxy-on', on)
  $('arGalaxy').hidden = !on
  $('galaxyBtn').classList.toggle('active', on)
})

// ── utils ─────────────────────────────────────────────────────────────────
function diag(s) { $('diag').textContent = s }

function clearRouteArtifacts() {
  document.querySelectorAll('.lab-route-results').forEach(el => el.remove())
  if (arGalaxy) {
    arGalaxy.setCandidates([])
    $('arGalaxy').hidden = true
    $('galaxyBtn').hidden = true
    $('galaxyBtn').classList.remove('active')
    document.querySelector('.lab-stage').classList.remove('galaxy-on')
  }
  lastSelected = []
  closeCandidatePanel()
}

// Snap/flip both invalidate any prior answer (it described a different frame
// or camera). Tear down the answer panel and routed candidates so the user isn't
// looking at a description of something that's no longer on screen.
function clearAnswerAndRoute() {
  clearRouteArtifacts()
  lastAnswer = ''
  $('answer').textContent = ''
  $('latencyBadge').textContent = ''
  $('modelBadge').hidden = true
  $('routeBtn').hidden = true
  $('askAgainBtn').hidden = true
  $('answerSection').hidden = true
}
